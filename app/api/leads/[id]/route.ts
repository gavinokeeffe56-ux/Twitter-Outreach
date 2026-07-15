import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { id } = await params;
  const body = await req.json();

  const patch: Record<string, unknown> = {};
  if ('stage' in body) patch.stage = String(body.stage);
  if ('notes' in body) patch.notes = String(body.notes);
  if ('draft' in body) patch.draft = String(body.draft);
  if ('email' in body) patch.email = body.email ? String(body.email) : null;
  if ('email_draft' in body) patch.emailDraft = body.email_draft;
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });

  await db.update(leads).set(patch).where(and(eq(leads.id, Number(id)), eq(leads.ownerId, user)));
  return NextResponse.json({ ok: true });
}
