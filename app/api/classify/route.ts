import { NextResponse } from 'next/server';
import { and, eq, gte, sql, count, desc } from 'drizzle-orm';
import { db, leads, settings } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { getResolvedSettings } from '@/lib/settings';
import { startJob, processClassifyBatch } from '@/lib/jobs';
import { stopJob, startJobLimit } from '@/lib/redis';
import { PRICING } from '@/lib/usage';

function eligible(user: string, minHScore: number) {
  return and(eq(leads.ownerId, user), sql`${leads.classifiedAt} is null`, gte(leads.hScore, minHScore));
}

// Estimate
export async function GET(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const q = new URL(req.url).searchParams;
  const minHScore = Number(q.get('minHScore') ?? 25);
  const limit = Math.min(20000, Number(q.get('limit') ?? 1000));
  const n = (await db.select({ n: count() }).from(leads).where(eligible(user, minHScore)))[0].n;
  const cnt = Math.min(limit, n);
  const s = await getResolvedSettings(user);
  if (s.provider === 'openai') return NextResponse.json({ count: cnt, model: s.openaiModel || '(no model set)', estimatedCostUSD: null });
  const p = PRICING[s.model] || PRICING['claude-opus-4-8'];
  const cost = cnt * ((600 / 1e6) * p.input + (200 / 1e6) * p.output);
  return NextResponse.json({ count: cnt, model: s.model, estimatedCostUSD: Math.round(cost * 100) / 100 });
}

// Start
export async function POST(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await startJobLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Slow down — you just started a job. Try again in a minute.' }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  // Persist the natural-language target so the background job picks it up.
  if (typeof body.target === 'string' && body.target.trim()) {
    await db.insert(settings).values({ userId: user, targetDescription: body.target.trim() })
      .onConflictDoUpdate({ target: settings.userId, set: { targetDescription: body.target.trim() } });
  }
  const minHScore = Number(body.minHScore ?? 15);
  const limit = Math.min(20000, Number(body.limit ?? 1500));
  const ids = (await db.select({ id: leads.id }).from(leads).where(eligible(user, minHScore))
    .orderBy(desc(leads.hScore)).limit(limit)).map((r) => r.id);
  if (!ids.length) return NextResponse.json({ error: 'No unclassified leads match. Try importing a list first, or lower the signal threshold.' }, { status: 400 });

  await startJob(user, 'classify', ids, '/api/qstash/classify', 'classify', processClassifyBatch);
  return NextResponse.json({ started: true, count: ids.length });
}

// Stop
export async function DELETE() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  await stopJob(user, 'classify');
  return NextResponse.json({ ok: true });
}
