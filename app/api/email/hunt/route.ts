import { NextResponse } from 'next/server';
import { and, eq, sql, count, desc } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { getResolvedSettings } from '@/lib/settings';
import { startJob, processEmailBatch } from '@/lib/jobs';
import { stopJob, startJobLimit } from '@/lib/redis';

// Eligible: no email yet, never scanned, and something to scan (website or @ in bio).
function eligible(user: string) {
  return and(
    eq(leads.ownerId, user),
    sql`${leads.email} is null`,
    sql`${leads.emailSource} is null`,
    sql`((${leads.website} is not null and ${leads.website} != '') or ${leads.bio} like '%@%')`
  );
}

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const n = (await db.select({ n: count() }).from(leads).where(eligible(user)))[0].n;
  const s = await getResolvedSettings(user);
  return NextResponse.json({ count: n, hunterEnabled: Boolean(s.hunterKey) });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await startJobLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Slow down — try again in a minute.' }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(20000, Number(body.limit ?? 2000));
  const ids = (await db.select({ id: leads.id }).from(leads).where(eligible(user))
    .orderBy(
      sql`case when ${leads.aiFit} in ('sponsor','guest','both') then 0 else 1 end`,
      desc(leads.aiScore), desc(leads.hScore)
    ).limit(limit)).map((r) => r.id);
  if (!ids.length) return NextResponse.json({ error: 'No leads left to hunt — all have an email, were scanned, or have nothing to scan.' }, { status: 400 });

  await startJob(user, 'email', ids, '/api/qstash/email', 'email', processEmailBatch);
  return NextResponse.json({ started: true, count: ids.length });
}

export async function DELETE() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  await stopJob(user, 'email');
  return NextResponse.json({ ok: true });
}
