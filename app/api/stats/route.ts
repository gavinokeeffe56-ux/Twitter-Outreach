import { NextResponse } from 'next/server';
import { and, eq, sql, count, gte } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const owner = eq(leads.ownerId, user);

  const total = (await db.select({ n: count() }).from(leads).where(owner))[0].n;
  const classified = (await db.select({ n: count() }).from(leads).where(and(owner, sql`${leads.classifiedAt} is not null`)))[0].n;
  const withEmail = (await db.select({ n: count() }).from(leads).where(and(owner, sql`${leads.email} is not null`)))[0].n;
  const byStage = await db.select({ stage: leads.stage, n: count() }).from(leads).where(owner).groupBy(leads.stage);
  const candidates = (await db.select({ n: count() }).from(leads).where(and(owner, sql`${leads.classifiedAt} is null`, gte(leads.hScore, 25))))[0].n;

  return NextResponse.json({ total, classified, withEmail, byStage, candidates });
}
