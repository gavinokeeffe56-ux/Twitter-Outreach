import { and, eq } from 'drizzle-orm';
import { after } from 'next/server';
import { db } from './db';
import { leads } from './db/schema';
import { getResolvedSettings } from './settings';
import { classifyLead, generateEmailDraft } from './classify';
import { findEmailForLead } from './email';
import { createGmailDraft } from './gmail';
import { advanceJob, failJob, getJob, initJob, type JobKind } from './redis';
import { publishBatches, chunk } from './qstash';

type Processor = (userId: string, leadIds: number[]) => Promise<void>;

// A batch is stale if the job it belongs to is no longer running — the user hit
// Stop, or the match target was reached. Skipping saves the AI spend.
async function jobStopped(userId: string, kind: JobKind) {
  return (await getJob(userId, kind)).status !== 'running';
}

// Kicks off a background job: records the total in Redis, then either publishes
// batches to QStash (production) or runs them inline after the response (local
// dev, when QSTASH_DEV_INLINE=true and QStash can't reach localhost).
export async function startJob(
  userId: string, kind: JobKind, ids: number[],
  consumerPath: string, flowKey: string, processor: Processor, target = 0
) {
  await initJob(userId, kind, ids.length, target);
  if (process.env.QSTASH_DEV_INLINE === 'true') {
    for (const batch of chunk(ids)) {
      after(() => processor(userId, batch).catch((e) => console.error('inline job error', e)));
    }
    return ids.length;
  }
  await publishBatches(consumerPath, userId, ids, flowKey);
  return ids.length;
}

// Each processor handles one QStash message (a small batch of lead ids) and
// records progress in Redis. All DB reads are owner-scoped.

export async function processClassifyBatch(userId: string, leadIds: number[]) {
  if (await jobStopped(userId, 'classify')) return;
  const s = await getResolvedSettings(userId);
  let done = 0, found = 0, errors = 0, lastError: string | undefined;
  for (const id of leadIds) {
    const lead = (await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.ownerId, userId))).limit(1))[0];
    if (!lead) { done++; continue; }
    try {
      const v = await classifyLead(s, lead, s.targetDescription);
      // Only count/auto-qualify grounded, strong matches — never a low-confidence guess.
      const strongMatch = v.fit !== 'none' && v.score >= 60 && v.confidence !== 'low';
      if (strongMatch) found++;
      const autoQualify = strongMatch && lead.stage === 'new';
      await db.update(leads).set({
        aiFit: v.fit, aiScore: v.score, aiCompany: v.company, aiRole: v.role,
        aiReasoning: v.reasoning, aiConfidence: v.confidence, aiEvidence: v.evidence,
        aiHooks: v.hooks, classifiedAt: new Date(),
        ...(autoQualify ? { stage: 'qualified' } : {})
      }).where(and(eq(leads.id, id), eq(leads.ownerId, userId)));
    } catch (err) {
      errors++; lastError = (err as Error).message;
    }
    done++;
  }
  await advanceJob(userId, 'classify', { done, found, errors, lastError });
}

export async function processEmailBatch(userId: string, leadIds: number[]) {
  if (await jobStopped(userId, 'email')) return;
  const s = await getResolvedSettings(userId);
  let done = 0, found = 0, errors = 0, lastError: string | undefined;
  for (const id of leadIds) {
    const lead = (await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.ownerId, userId))).limit(1))[0];
    if (!lead) { done++; continue; }
    try {
      const result = await findEmailForLead(s, lead);
      await db.update(leads).set({ email: result?.email ?? null, emailSource: result?.source ?? 'not_found' })
        .where(and(eq(leads.id, id), eq(leads.ownerId, userId)));
      if (result) found++;
    } catch (err) {
      errors++; lastError = (err as Error).message;
      await db.update(leads).set({ email: null, emailSource: 'not_found' })
        .where(and(eq(leads.id, id), eq(leads.ownerId, userId)));
    }
    done++;
  }
  await advanceJob(userId, 'email', { done, found, errors, lastError });
}

export async function processGmailBatch(userId: string, leadIds: number[]) {
  if (await jobStopped(userId, 'gmail')) return;
  const s = await getResolvedSettings(userId);
  let done = 0, drafted = 0, errors = 0, lastError: string | undefined;
  for (const id of leadIds) {
    const lead = (await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.ownerId, userId))).limit(1))[0];
    if (!lead || !lead.email) { done++; continue; }
    try {
      let draft = lead.emailDraft;
      if (!draft?.body) {
        draft = await generateEmailDraft(s, lead, lead.aiFit === 'sponsor' ? 'sponsor' : 'guest');
        await db.update(leads).set({ emailDraft: draft }).where(and(eq(leads.id, id), eq(leads.ownerId, userId)));
      }
      const gid = await createGmailDraft(userId, { to: lead.email, subject: draft.subject, body: draft.body });
      await db.update(leads).set({ gmailDraftId: gid }).where(and(eq(leads.id, id), eq(leads.ownerId, userId)));
      drafted++;
    } catch (err) {
      errors++; lastError = (err as Error).message;
      // A Gmail auth failure affects every remaining lead — stop the run.
      if (/permission|token refresh|No Google account|expired/i.test(lastError)) {
        await advanceJob(userId, 'gmail', { done, drafted, errors, lastError });
        await failJob(userId, 'gmail', lastError);
        return;
      }
    }
    done++;
  }
  await advanceJob(userId, 'gmail', { done, drafted, errors, lastError });
}
