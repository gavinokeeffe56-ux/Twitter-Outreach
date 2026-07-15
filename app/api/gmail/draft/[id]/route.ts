import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { createGmailDraft } from '@/lib/gmail';
import { singleActionLimit } from '@/lib/redis';

export const maxDuration = 30;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await singleActionLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Too many requests — wait a moment.' }, { status: 429 });

  const { id } = await params;
  const lead = (await db.select().from(leads).where(and(eq(leads.id, Number(id)), eq(leads.ownerId, user))).limit(1))[0];
  if (!lead) return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const to = String(body.email || lead.email || '').trim();
  if (!to) return NextResponse.json({ error: 'No email address on this lead yet.' }, { status: 400 });
  const subject = String(body.subject || '');
  const emailBody = String(body.body || '');
  if (!emailBody.trim()) return NextResponse.json({ error: 'Write or generate the email body first.' }, { status: 400 });

  try {
    const draftId = await createGmailDraft(user, { to, subject, body: emailBody });
    await db.update(leads).set({ gmailDraftId: draftId, emailDraft: { subject, body: emailBody } })
      .where(and(eq(leads.id, lead.id), eq(leads.ownerId, user)));
    return NextResponse.json({ ok: true, draftId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
