import { eq, desc } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';

const COLS: (keyof typeof leads.$inferSelect)[] = [
  'handle', 'xUserId', 'name', 'bio', 'followers', 'website', 'location', 'email', 'emailSource',
  'hScore', 'aiFit', 'aiScore', 'aiCompany', 'aiRole', 'aiReasoning', 'aiHooks', 'stage', 'notes', 'draft', 'emailDraft', 'gmailDraftId'
];

const esc = (v: unknown) => {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const rows = await db.select().from(leads).where(eq(leads.ownerId, user))
    .orderBy(desc(leads.aiScore), desc(leads.hScore));
  const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n');
  return new NextResponse(csv, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="outreach-pipeline.csv"' }
  });
}
