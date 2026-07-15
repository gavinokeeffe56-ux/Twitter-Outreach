import {
  pgTable, text, integer, timestamp, jsonb, boolean, serial, primaryKey, uniqueIndex, index, doublePrecision
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

// ---- Auth.js core tables (Drizzle adapter shape) ----

export const users = pgTable('user', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image')
});

export const accounts = pgTable('account', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').$type<AdapterAccountType>().notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('providerAccountId').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state')
}, (a) => ({
  pk: primaryKey({ columns: [a.provider, a.providerAccountId] })
}));

export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull()
});

export const verificationTokens = pgTable('verificationToken', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { mode: 'date' }).notNull()
}, (vt) => ({
  pk: primaryKey({ columns: [vt.identifier, vt.token] })
}));

// ---- App tables (all owner-scoped) ----

export const settings = pgTable('settings', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  showName: text('show_name').default('').notNull(),
  hostName: text('host_name').default('').notNull(),
  showDescription: text('show_description').default('').notNull(),
  guestCriteria: text('guest_criteria').default('Founders or operators with a compelling story, relevant to my audience, comfortable talking in public.').notNull(),
  sponsorCriteria: text('sponsor_criteria').default('Startups with a live product, some funding or revenue, whose target customers overlap with my audience.').notNull(),
  // Natural-language target: what the AI hunts the list for.
  targetDescription: text('target_description'),
  // Separate outreach templates per channel + a shared pool of proof points the AI picks from.
  // Nullable in the DB; app fills defaults from lib/defaults.ts when unset (see getResolvedSettings).
  dmTemplate: text('dm_template'),
  emailTemplate: text('email_template'),
  messageTemplate: text('message_template'), // legacy — superseded by dm/email templates
  proofPoints: jsonb('proof_points').$type<string[]>(),
  proofPointCount: integer('proof_point_count'),
  provider: text('provider').default('anthropic').notNull(),
  model: text('model').default('claude-opus-4-8').notNull(),
  openaiBaseUrl: text('openai_base_url').default('').notNull(),
  openaiModel: text('openai_model').default('').notNull(),
  // Secrets — encrypted at rest (AES-256-GCM). See lib/crypto.ts.
  anthropicKeyEnc: text('anthropic_key_enc'),
  openaiKeyEnc: text('openai_key_enc'),
  hunterKeyEnc: text('hunter_key_enc'),
  tombaKeyEnc: text('tomba_key_enc'),
  tombaSecretEnc: text('tomba_secret_enc'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// Per-call usage log — powers the cost/usage tracker.
export const usageEvents = pgTable('usage_events', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  kind: text('kind').notNull(),        // classify | message | email_draft | dm_draft | email_lookup
  provider: text('provider').notNull(),// anthropic | openai | hunter | tomba
  model: text('model'),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  costUsd: doublePrecision('cost_usd').default(0).notNull()
}, (u) => ({
  ownerCreated: index('usage_owner_created_idx').on(u.ownerId, u.createdAt)
}));

export type UsageEvent = typeof usageEvents.$inferSelect;

export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  handle: text('handle').notNull(),
  xUserId: text('x_user_id'),
  name: text('name'),
  bio: text('bio'),
  followers: integer('followers'),
  website: text('website'),
  location: text('location'),
  email: text('email'),
  emailSource: text('email_source'),
  emailDraft: jsonb('email_draft').$type<{ subject: string; body: string } | null>(),
  gmailDraftId: text('gmail_draft_id'),
  hScore: integer('h_score').default(0).notNull(),
  hSignals: jsonb('h_signals').$type<string[]>().default([]).notNull(),
  aiFit: text('ai_fit'),
  aiScore: integer('ai_score'),
  aiCompany: text('ai_company'),
  aiRole: text('ai_role'),
  aiReasoning: text('ai_reasoning'),
  aiConfidence: text('ai_confidence'),   // high | medium | low — how well the profile supports the match
  aiEvidence: text('ai_evidence'),       // the profile text the score is grounded in
  aiHooks: jsonb('ai_hooks').$type<string[]>(),
  classifiedAt: timestamp('classified_at'),
  stage: text('stage').default('new').notNull(),
  notes: text('notes').default('').notNull(),
  draft: text('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (l) => ({
  ownerHandle: uniqueIndex('leads_owner_handle_idx').on(l.ownerId, l.handle),
  ownerStage: index('leads_owner_stage_idx').on(l.ownerId, l.stage),
  ownerScore: index('leads_owner_score_idx').on(l.ownerId, l.aiScore)
}));

export type Lead = typeof leads.$inferSelect;
export type Settings = typeof settings.$inferSelect;
