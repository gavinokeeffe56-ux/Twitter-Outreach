import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings } from './db/schema';
import { decrypt } from './crypto';
import { DEFAULT_DM_TEMPLATE, DEFAULT_EMAIL_TEMPLATE, DEFAULT_PROOF_POINTS, DEFAULT_TARGET } from './defaults';

export interface ResolvedSettings {
  userId: string;
  showName: string;
  hostName: string;
  showDescription: string;
  guestCriteria: string;
  sponsorCriteria: string;
  targetDescription: string;
  dmTemplate: string;
  emailTemplate: string;
  proofPoints: string[];
  proofPointCount: number;
  provider: string;
  model: string;
  openaiBaseUrl: string;
  openaiModel: string;
  anthropicKey: string;
  openaiKey: string;
  hunterKey: string;
  tombaKey: string;
  tombaSecret: string;
}

// Ensures a settings row exists, then returns it with secrets decrypted.
export async function getResolvedSettings(userId: string): Promise<ResolvedSettings> {
  let row = (await db.select().from(settings).where(eq(settings.userId, userId)).limit(1))[0];
  if (!row) {
    await db.insert(settings).values({ userId }).onConflictDoNothing();
    row = (await db.select().from(settings).where(eq(settings.userId, userId)).limit(1))[0];
  }
  return {
    userId,
    showName: row.showName,
    hostName: row.hostName,
    showDescription: row.showDescription,
    guestCriteria: row.guestCriteria,
    sponsorCriteria: row.sponsorCriteria,
    targetDescription: row.targetDescription ?? DEFAULT_TARGET,
    dmTemplate: row.dmTemplate ?? DEFAULT_DM_TEMPLATE,
    emailTemplate: row.emailTemplate ?? row.messageTemplate ?? DEFAULT_EMAIL_TEMPLATE,
    proofPoints: row.proofPoints ?? DEFAULT_PROOF_POINTS,
    proofPointCount: row.proofPointCount ?? 4,
    provider: row.provider,
    model: row.model,
    openaiBaseUrl: row.openaiBaseUrl,
    openaiModel: row.openaiModel,
    anthropicKey: decrypt(row.anthropicKeyEnc),
    openaiKey: decrypt(row.openaiKeyEnc),
    hunterKey: decrypt(row.hunterKeyEnc),
    tombaKey: decrypt(row.tombaKeyEnc),
    tombaSecret: decrypt(row.tombaSecretEnc)
  };
}
