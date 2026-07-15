import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, settings, accounts } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { getResolvedSettings } from '@/lib/settings';
import { encrypt } from '@/lib/crypto';

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const s = await getResolvedSettings(user);
  const acct = (await db.select({ rt: accounts.refresh_token }).from(accounts)
    .where(and(eq(accounts.userId, user), eq(accounts.provider, 'google'))).limit(1))[0];
  return NextResponse.json({
    showName: s.showName, hostName: s.hostName, showDescription: s.showDescription,
    guestCriteria: s.guestCriteria, sponsorCriteria: s.sponsorCriteria,
    targetDescription: s.targetDescription,
    dmTemplate: s.dmTemplate, emailTemplate: s.emailTemplate, proofPoints: s.proofPoints, proofPointCount: s.proofPointCount,
    provider: s.provider, model: s.model, openaiBaseUrl: s.openaiBaseUrl, openaiModel: s.openaiModel,
    hasAnthropicKey: Boolean(s.anthropicKey), hasOpenaiKey: Boolean(s.openaiKey),
    hasHunterKey: Boolean(s.hunterKey), hasTombaKey: Boolean(s.tombaKey && s.tombaSecret),
    gmailConnected: Boolean(acct?.rt)
  });
}

const PLAIN = ['showName', 'hostName', 'showDescription', 'guestCriteria', 'sponsorCriteria', 'targetDescription', 'dmTemplate', 'emailTemplate', 'provider', 'model', 'openaiBaseUrl', 'openaiModel'] as const;
const SECRET: Record<string, string> = { anthropicKey: 'anthropicKeyEnc', openaiKey: 'openaiKeyEnc', hunterKey: 'hunterKeyEnc', tombaKey: 'tombaKeyEnc', tombaSecret: 'tombaSecretEnc' };

export async function PUT(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  const body = await req.json();

  const patch: Record<string, unknown> = { userId: user, updatedAt: new Date() };
  for (const k of PLAIN) if (k in body) patch[k] = String(body[k] ?? '');
  for (const [k, col] of Object.entries(SECRET)) {
    if (k in body && String(body[k]).trim()) patch[col] = encrypt(String(body[k]).trim());
  }
  if (Array.isArray(body.proofPoints)) {
    patch.proofPoints = body.proofPoints.map((p: unknown) => String(p).trim()).filter(Boolean);
  }
  if ('proofPointCount' in body) {
    patch.proofPointCount = Math.max(1, Math.min(8, Number(body.proofPointCount) || 4));
  }

  await db.insert(settings).values(patch as typeof settings.$inferInsert)
    .onConflictDoUpdate({ target: settings.userId, set: patch });
  return NextResponse.json({ ok: true });
}
