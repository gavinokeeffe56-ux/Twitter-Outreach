import { NextResponse } from 'next/server';
import { and, eq, gte, or, like, desc, asc, sql, count } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';

const SORT_COLS = { ai_score: leads.aiScore, h_score: leads.hScore, followers: leads.followers, handle: leads.handle, stage: leads.stage, created_at: leads.createdAt } as const;

export async function GET(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const q = new URL(req.url).searchParams;

  const conds = [eq(leads.ownerId, user)];
  if (q.get('stage')) conds.push(eq(leads.stage, q.get('stage')!));
  if (q.get('fit')) conds.push(eq(leads.aiFit, q.get('fit')!));
  if (q.get('minHScore')) conds.push(gte(leads.hScore, Number(q.get('minHScore'))));
  if (q.get('minAiScore')) conds.push(gte(leads.aiScore, Number(q.get('minAiScore'))));
  if (q.get('classified') === 'yes') conds.push(sql`${leads.classifiedAt} is not null`);
  if (q.get('classified') === 'no') conds.push(sql`${leads.classifiedAt} is null`);
  if (q.get('strong') === 'yes') conds.push(eq(leads.aiConfidence, 'high'));
  const search = q.get('search');
  if (search) {
    const p = `%${search}%`;
    conds.push(or(like(leads.handle, p), like(leads.name, p), like(leads.bio, p), like(leads.aiCompany, p))!);
  }
  const where = and(...conds);

  const sortCol = SORT_COLS[(q.get('sort') as keyof typeof SORT_COLS)] ?? leads.aiScore;
  const dir = q.get('dir') === 'asc' ? asc : desc;
  const pageSize = Math.min(500, Math.max(1, Number(q.get('pageSize') || 100)));
  const page = Math.max(1, Number(q.get('page') || 1));

  const total = (await db.select({ n: count() }).from(leads).where(where))[0].n;
  const rows = await db.select().from(leads).where(where)
    .orderBy(sql`${sortCol} ${sql.raw(q.get('dir') === 'asc' ? 'asc' : 'desc')} nulls last`, desc(leads.hScore))
    .limit(pageSize).offset((page - 1) * pageSize);

  return NextResponse.json({ rows, total, page, pageSize });
}

export async function DELETE() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  await db.delete(leads).where(eq(leads.ownerId, user));
  return NextResponse.json({ ok: true });
}
