import { and, eq, ne, desc, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';

const COLS: (keyof typeof leads.$inferSelect)[] = [
  'handle', 'xUserId', 'name', 'bio', 'followers', 'website', 'location', 'email', 'emailSource',
  'hScore', 'aiFit', 'aiScore', 'aiConfidence', 'aiCompany', 'aiRole', 'aiReasoning', 'aiHooks', 'stage', 'notes', 'draft', 'emailDraft', 'gmailDraftId'
];

const esc = (v: unknown) => {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/export                      → everything
// GET /api/export?best=200             → top 200 AI matches by score
// GET /api/export?best=200&fit=sponsor → top 200 sponsor matches ("both" counts)
export async function GET(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const q = new URL(req.url).searchParams;
  const best = Math.max(0, Math.min(20000, Math.floor(Number(q.get('best') ?? 0)) || 0));
  const fit = q.get('fit');

  const conds: SQL[] = [eq(leads.ownerId, user)];
  if (best > 0) {
    conds.push(isNotNull(leads.classifiedAt), ne(leads.aiFit, 'none'));
    if (fit === 'sponsor') conds.push(inArray(leads.aiFit, ['sponsor', 'both']));
    else if (fit === 'guest') conds.push(inArray(leads.aiFit, ['guest', 'both']));
  }
  let query = db.select().from(leads).where(and(...conds))
    .orderBy(desc(leads.aiScore), desc(leads.hScore)).$dynamic();
  if (best > 0) query = query.limit(best);
  const rows = await query;

  const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n');
  const name = best > 0 ? `top-${best}${fit ? '-' + fit + 's' : '-matches'}.csv` : 'outreach-pipeline.csv';
  // BOM so Excel opens it as UTF-8 directly.
  return new NextResponse('\uFEFF' + csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }
  });
}
