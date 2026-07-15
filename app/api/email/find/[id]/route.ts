import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { getResolvedSettings } from '@/lib/settings';
import { findEmailForLead } from '@/lib/email';
import { singleActionLimit } from '@/lib/redis';

export const maxDuration = 30;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await singleActionLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Too many requests — wait a moment.' }, { status: 429 });

  const { id } = await params;
  const lead = (await db.select().from(leads).where(and(eq(leads.id, Number(id)), eq(leads.ownerId, user))).limit(1))[0];
  if (!lead) return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });

  try {
    const result = await findEmailForLead(await getResolvedSettings(user), lead);
    await db.update(leads).set({ email: result?.email ?? null, emailSource: result?.source ?? 'not_found' })
      .where(and(eq(leads.id, lead.id), eq(leads.ownerId, user)));
    return NextResponse.json(result || { email: null, source: 'not_found' });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
