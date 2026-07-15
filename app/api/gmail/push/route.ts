import { NextResponse } from 'next/server';
import { and, eq, sql, count, desc, inArray } from 'drizzle-orm';
import { db, leads, accounts } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { startJob, processGmailBatch } from '@/lib/jobs';
import { stopJob, startJobLimit } from '@/lib/redis';

// Eligible: has an email, not already in Gmail Drafts, still New/Qualified.
function eligible(user: string) {
  return and(
    eq(leads.ownerId, user),
    sql`${leads.email} is not null`,
    sql`${leads.gmailDraftId} is null`,
    inArray(leads.stage, ['new', 'qualified'])
  );
}

async function gmailConnected(user: string) {
  const acct = (await db.select({ rt: accounts.refresh_token }).from(accounts)
    .where(and(eq(accounts.userId, user), eq(accounts.provider, 'google'))).limit(1))[0];
  return Boolean(acct?.rt);
}

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const count_ = (await db.select({ n: count() }).from(leads).where(eligible(user)))[0].n;
  const needDrafts = (await db.select({ n: count() }).from(leads)
    .where(and(eligible(user), sql`${leads.emailDraft} is null`)))[0].n;
  return NextResponse.json({ count: count_, needDrafts, connected: await gmailConnected(user) });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await startJobLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Slow down — try again in a minute.' }, { status: 429 });
  if (!(await gmailConnected(user))) return NextResponse.json({ error: 'Gmail not connected — sign out and back in to grant Gmail access.' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(500, Number(body.limit ?? 200));
  const ids = (await db.select({ id: leads.id }).from(leads).where(eligible(user))
    .orderBy(desc(leads.aiScore), desc(leads.hScore)).limit(limit)).map((r) => r.id);
  if (!ids.length) return NextResponse.json({ error: 'Nothing to push — no New/Qualified leads with an email that aren\'t already drafted.' }, { status: 400 });

  await startJob(user, 'gmail', ids, '/api/qstash/gmail', 'gmail', processGmailBatch);
  return NextResponse.json({ started: true, count: ids.length });
}

export async function DELETE() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  await stopJob(user, 'gmail');
  return NextResponse.json({ ok: true });
}
