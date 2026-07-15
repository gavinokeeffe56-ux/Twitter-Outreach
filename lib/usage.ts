import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db';
import { usageEvents } from './db/schema';

// $ per 1M tokens. Cost tracking is exact for these Anthropic models.
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

export function costOf(model: string, usage: any): number {
  const p = PRICING[model];
  if (!p) return 0;
  const inTok = usage?.input_tokens || 0;
  const outTok = usage?.output_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const cacheCreate = usage?.cache_creation_input_tokens || 0;
  return (inTok * p.input + cacheRead * p.input * 0.1 + cacheCreate * p.input * 1.25 + outTok * p.output) / 1e6;
}

// Best-effort — a usage-log failure must never break the actual work.
export async function recordAiUsage(userId: string, kind: string, provider: string, model: string, usage: any) {
  try {
    const inTok = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
    await db.insert(usageEvents).values({
      ownerId: userId, kind, provider, model,
      inputTokens: inTok, outputTokens: usage?.output_tokens || 0,
      costUsd: costOf(model, usage)
    });
  } catch (e) { console.error('recordAiUsage failed', e); }
}

export async function recordLookup(userId: string, provider: string) {
  try {
    await db.insert(usageEvents).values({ ownerId: userId, kind: 'email_lookup', provider, model: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  } catch (e) { console.error('recordLookup failed', e); }
}

export async function getUsageSummary(userId: string) {
  const owner = eq(usageEvents.ownerId, userId);
  const ai = and(owner, sql`${usageEvents.kind} != 'email_lookup'`);

  const totals = (await db.select({
    cost: sql<number>`coalesce(sum(${usageEvents.costUsd}),0)`,
    inTok: sql<number>`coalesce(sum(${usageEvents.inputTokens}),0)`,
    outTok: sql<number>`coalesce(sum(${usageEvents.outputTokens}),0)`,
    calls: sql<number>`count(*)`
  }).from(usageEvents).where(ai))[0];

  const byKind = await db.select({
    kind: usageEvents.kind,
    calls: sql<number>`count(*)`,
    cost: sql<number>`coalesce(sum(${usageEvents.costUsd}),0)`,
    inTok: sql<number>`coalesce(sum(${usageEvents.inputTokens}),0)`,
    outTok: sql<number>`coalesce(sum(${usageEvents.outputTokens}),0)`
  }).from(usageEvents).where(ai).groupBy(usageEvents.kind);

  const lookups = await db.select({
    provider: usageEvents.provider,
    calls: sql<number>`count(*)`
  }).from(usageEvents).where(and(owner, sql`${usageEvents.kind} = 'email_lookup'`)).groupBy(usageEvents.provider);

  const daily = await db.select({
    day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
    cost: sql<number>`coalesce(sum(${usageEvents.costUsd}),0)`,
    calls: sql<number>`count(*)`
  }).from(usageEvents)
    .where(and(ai, gte(usageEvents.createdAt, sql`now() - interval '30 days'`)))
    .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageEvents.createdAt})`);

  return {
    totalCost: Number(totals?.cost) || 0,
    inputTokens: Number(totals?.inTok) || 0,
    outputTokens: Number(totals?.outTok) || 0,
    calls: Number(totals?.calls) || 0,
    emailLookups: lookups.reduce((n, l) => n + Number(l.calls), 0),
    byKind: byKind.map((k) => ({ kind: k.kind, calls: Number(k.calls), cost: Number(k.cost), inTok: Number(k.inTok), outTok: Number(k.outTok) })),
    lookups: lookups.map((l) => ({ provider: l.provider, calls: Number(l.calls) })),
    daily: daily.map((d) => ({ day: d.day, cost: Number(d.cost), calls: Number(d.calls) }))
  };
}
