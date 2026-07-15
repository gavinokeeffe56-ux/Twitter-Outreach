import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { getResolvedSettings } from '@/lib/settings';
import { generateOutreachMessage } from '@/lib/classify';
import { singleActionLimit } from '@/lib/redis';

export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const { success } = await singleActionLimit.limit(user);
  if (!success) return NextResponse.json({ error: 'Too many requests — wait a moment.' }, { status: 429 });

  const { id } = await params;
  const lead = (await db.select().from(leads).where(and(eq(leads.id, Number(id)), eq(leads.ownerId, user))).limit(1))[0];
  if (!lead) return NextResponse.json({ error: 'Lead not found.' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const channel: 'dm' | 'email' = body.channel === 'email' ? 'email' : 'dm';
  try {
    const result = await generateOutreachMessage(await getResolvedSettings(user), lead, channel);
    // Save into the same fields the drawer's copy/open/Gmail actions already use.
    if (channel === 'email') {
      await db.update(leads).set({ emailDraft: { subject: result.subject || '', body: result.message } })
        .where(and(eq(leads.id, lead.id), eq(leads.ownerId, user)));
    } else {
      await db.update(leads).set({ draft: result.message })
        .where(and(eq(leads.id, lead.id), eq(leads.ownerId, user)));
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
