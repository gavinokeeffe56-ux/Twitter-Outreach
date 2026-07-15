import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedSettings } from './settings';
import type { Lead } from './db/schema';
import { recordAiUsage } from './usage';
import { fetchWebsiteText } from './email';

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    is_startup_operator: { type: 'boolean', description: 'True if this person founded, runs, or is a senior operator at a startup or company.' },
    company: { type: ['string', 'null'], description: 'Company/product name if identifiable, else null.' },
    role: { type: ['string', 'null'], description: 'Their role, e.g. "Founder & CEO", else null.' },
    fit: { type: 'string', enum: ['sponsor', 'guest', 'both', 'none'], description: 'sponsor = company with likely budget & product relevant to the audience; guest = compelling founder/operator story; both; none.' },
    score: { type: 'integer', description: 'Outreach priority from 0 (skip) to 100 (reach out today). Below 40 means weak fit.' },
    reasoning: { type: 'string', description: 'One or two sentences explaining the classification, grounded in the profile.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How well the profile actually supports this match. high = explicit evidence in the profile for the key criteria; medium = partial or reasonably inferred; low = thin info, or you are relying on outside knowledge / guessing.' },
    evidence: { type: 'string', description: 'Quote the specific text from their profile (bio, name, or website) that supports the match. If a key criterion cannot be verified from the profile, say which one and that it is unverified.' },
    hooks: { type: 'array', items: { type: 'string' }, description: '1-3 short personalization hooks drawn from their profile, usable in a DM.' }
  },
  required: ['is_startup_operator', 'company', 'role', 'fit', 'score', 'reasoning', 'confidence', 'evidence', 'hooks'],
  additionalProperties: false
} as const;

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Specific, personal subject line under 60 characters.' },
    body: { type: 'string', description: 'Plain-text email body.' }
  },
  required: ['subject', 'body'],
  additionalProperties: false
} as const;

export interface Verdict { fit: string; score: number; company: string | null; role: string | null; reasoning: string; confidence: string; evidence: string; hooks: string[]; }

function anthropicClient(s: ResolvedSettings) {
  return new Anthropic({ apiKey: s.anthropicKey || process.env.ANTHROPIC_API_KEY });
}

function showContext(s: ResolvedSettings) {
  return [
    `Show: ${s.showName || '(unnamed show)'}`,
    `About the show and audience: ${s.showDescription || '(no description provided)'}`,
    `What makes a good GUEST: ${s.guestCriteria}`,
    `What makes a good SPONSOR: ${s.sponsorCriteria}`
  ].join('\n');
}

function classifySystem(s: ResolvedSettings, target?: string) {
  if (target && target.trim()) {
    return `You are finding the best leads for a show host from their X (Twitter) following list. Each input is ONE profile.

THE HOST IS LOOKING FOR:
${target.trim()}

${showContext(s)}

GROUND RULES — this is what keeps you accurate, follow it strictly:
- You have the profile (bio, name, website, follower count, location) and, when available, the company's website homepage text. Judge only on THAT — nothing else.
- When website content is provided, treat it as verified information about what the company does. Lean on it especially for the "category leader" and "growth-stage" judgments, and cite it in your evidence.
- Do NOT invent or assume facts that aren't in the profile or the website text. Never assert funding, revenue, budgets, company stage, or "they advertise on podcasts" as fact unless it's actually stated.
- You may use well-known public facts about clearly-identifiable major companies, but if you're leaning on outside knowledge or guessing, treat it as an assumption and lower your confidence.
- Some criteria usually CANNOT be verified from an X profile (e.g. whether a company advertises on podcasts, or its exact funding stage). Do not claim these as fact. Treat them as likelihoods based on the company's category/type, and reflect that uncertainty in confidence.
- If the profile is thin, or you can't find real evidence for the key criteria, score LOW and set confidence LOW. A confident guess is worse than an honest "not enough info".

For each profile return:
- score: 0-100 for match strength (100 = clear, evidence-backed match; below 40 = weak or unverifiable).
- fit: SPONSOR, GUEST, BOTH, or NONE.
- company / role: extract only if stated or clearly identifiable, else null.
- reasoning: one or two sentences, grounded in the profile.
- confidence: high only when the profile explicitly supports the key criteria; medium if partial or reasonably inferred; low if thin or guessing.
- evidence: quote the exact profile text your judgment rests on, and name any key criterion you could NOT verify from the profile.
- hooks: 1-3 short personalization hooks from their profile.

Be skeptical and precise. Fans, students, junior employees, and profiles with no real company signal are low scores / "none". Do not inflate scores to seem helpful.`;
  }
  return `You qualify leads for outreach on behalf of a show host. Each lead is an X (Twitter) profile from the host's follower/following list.

${showContext(s)}

Decide whether the person operates a startup or company, and whether they fit better as a potential SPONSOR, GUEST, BOTH, or NONE. Be skeptical: vague bios, fans, students, and pure job-title employees with no operating role are "none". Score is outreach priority.`;
}

function leadPrompt(lead: Lead) {
  return [
    `Handle: @${lead.handle}`,
    `Name: ${lead.name || '(none)'}`,
    `Bio: ${lead.bio || '(empty)'}`,
    `Followers: ${lead.followers ?? 'unknown'}`,
    `Website: ${lead.website || '(none)'}`,
    `Location: ${lead.location || '(none)'}`
  ].join('\n');
}

// ---- OpenAI-compatible provider (Ollama, Groq, Together…) ----

class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

async function openaiChat(s: ResolvedSettings, opts: { system: string; user: string; schema?: object; maxTokens: number }) {
  const baseUrl = (s.openaiBaseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
  if (!s.openaiModel) throw new ProviderError('No model name set for the OpenAI-compatible provider.', 400);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.openaiKey) headers.Authorization = `Bearer ${s.openaiKey}`;
  const messages = [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }];
  const attempts = opts.schema
    ? [{ response_format: { type: 'json_schema', json_schema: { name: 'result', schema: opts.schema, strict: true } } }, { response_format: { type: 'json_object' } }, {}]
    : [{}];

  let lastErr: ProviderError | undefined;
  for (const extra of attempts) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: s.openaiModel, messages, max_tokens: opts.maxTokens, ...extra })
      });
    } catch (err) {
      throw new ProviderError(`Can't reach ${baseUrl} — is the server running? (${(err as Error).message})`);
    }
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new ProviderError('Provider returned an empty response.', 500);
      return text as string;
    }
    const body = await res.text();
    lastErr = new ProviderError(`Provider error ${res.status}: ${body.slice(0, 300)}`, res.status);
    if (!(res.status === 400 && /response_format|json_schema|format/i.test(body))) throw lastErr;
  }
  throw lastErr;
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Model did not return JSON: ${text.slice(0, 120)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeVerdict(r: any): Verdict {
  const fit = ['sponsor', 'guest', 'both', 'none'].includes(r.fit) ? r.fit : 'none';
  let score = Math.round(Number(r.score));
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, score));
  const confidence = ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low';
  return {
    fit, score,
    company: r.company ? String(r.company) : null,
    role: r.role ? String(r.role) : null,
    reasoning: r.reasoning ? String(r.reasoning) : '',
    confidence,
    evidence: r.evidence ? String(r.evidence) : '',
    hooks: Array.isArray(r.hooks) ? r.hooks.slice(0, 3).map(String) : []
  };
}

export async function classifyLead(s: ResolvedSettings, lead: Lead, target?: string): Promise<Verdict> {
  // Enrichment: read the company's website so the AI judges on real data, not a thin bio.
  let websiteText = '';
  if (lead.website) { try { websiteText = await fetchWebsiteText(lead.website); } catch { /* skip on failure */ } }
  const userContent = leadPrompt(lead) + (websiteText
    ? `\n\nWebsite homepage content (verified — what the company actually says about itself):\n"""\n${websiteText}\n"""`
    : '\n\n(No website content available — judge on the profile alone, and lower confidence for anything you cannot verify.)');

  if (s.provider === 'openai') {
    const system = `${classifySystem(s, target)}

Respond with ONLY a JSON object matching this schema (no prose, no markdown fences):
${JSON.stringify(CLASSIFY_SCHEMA.properties)}
Required keys: ${CLASSIFY_SCHEMA.required.join(', ')}. "fit" must be one of sponsor|guest|both|none. "score" is an integer 0-100.`;
    const text = await openaiChat(s, { system, user: userContent, schema: CLASSIFY_SCHEMA, maxTokens: 1024 });
    return normalizeVerdict(extractJson(text));
  }
  const response = await anthropicClient(s).messages.create({
    model: s.model || 'claude-opus-4-8',
    max_tokens: 1024,
    system: classifySystem(s, target),
    output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    messages: [{ role: 'user', content: userContent }]
  });
  await recordAiUsage(s.userId, 'classify', 'anthropic', s.model || 'claude-opus-4-8', response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`No text block returned (stop_reason: ${response.stop_reason})`);
  return normalizeVerdict(JSON.parse(text.text));
}

export async function generateDraft(s: ResolvedSettings, lead: Lead, track: 'guest' | 'sponsor') {
  const hooks = (lead.aiHooks || []);
  const system = `You write short, casual, personalized X (Twitter) DMs on behalf of a show host doing outreach.

${showContext(s)}

Rules: under 500 characters. Sound like a human, not a marketer. Reference something specific from their profile. One clear ask. No hashtags, no more than one emoji, no "I hope this finds you well". Output ONLY the DM text.`;
  const user = `Write a DM inviting this person to ${track === 'sponsor' ? 'explore sponsoring the show' : 'come on the show as a guest'}.

${leadPrompt(lead)}
${lead.aiCompany ? `Company: ${lead.aiCompany}` : ''}
${lead.aiRole ? `Role: ${lead.aiRole}` : ''}
${hooks.length ? `Personalization hooks: ${hooks.join(' | ')}` : ''}`;

  if (s.provider === 'openai') return (await openaiChat(s, { system, user, maxTokens: 1024 })).trim();

  const response = await anthropicClient(s).messages.create({
    model: s.model || 'claude-opus-4-8', max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system, messages: [{ role: 'user', content: user }]
  });
  await recordAiUsage(s.userId, 'dm_draft', 'anthropic', s.model || 'claude-opus-4-8', response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`No text returned (stop_reason: ${response.stop_reason})`);
  return text.text.trim();
}

// ---- Personalized outreach message (template + proof-point selection) ----

const OUTREACH_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: ['string', 'null'], description: 'For email only: a short, specific subject line under 60 chars referencing them. null for DMs.' },
    message: { type: 'string', description: 'The finished, ready-to-send personalized message.' },
    chosen_points: { type: 'array', items: { type: 'string' }, description: 'The proof points you selected for this recipient, copied from the pool.' }
  },
  required: ['subject', 'message', 'chosen_points'],
  additionalProperties: false
} as const;

export interface OutreachMessage { subject: string | null; message: string; chosenPoints: string[]; }

export async function generateOutreachMessage(s: ResolvedSettings, lead: Lead, channel: 'dm' | 'email'): Promise<OutreachMessage> {
  const track: 'guest' | 'sponsor' = lead.aiFit === 'guest' ? 'guest' : 'sponsor';
  const n = s.proofPointCount || 4;
  const pool = (s.proofPoints || []).map((p) => `- ${p}`).join('\n');

  const system = `You draft personalized outreach messages for a show host reaching out to a potential ${track}. Adapt the base template for ONE specific recipient so it reads as if written for them and maximizes the chance of a reply that leads to a meeting.

${showContext(s)}
Sender / sign-off: ${s.hostName || 'the host'}

BASE TEMPLATE — match its voice, structure, and rough length. The proof points shown inside it are only an example set; swap in the ones you pick below.
"""
${channel === 'email' ? s.emailTemplate : s.dmTemplate}
"""

TRACTION PROOF POINTS — this is a pool to choose from. Select the ${n} that would matter MOST to THIS specific recipient given their company, role, and focus, and weave them in where the template lists proof points. Do NOT include all of them, and don't invent new ones.
${pool}

How to choose well: match proof points to what this person cares about. An AI-infra or dev-tools company → the technical/AI-researcher audience and the AI-category partners (Databricks, ElevenLabs) and relevant guest names. A crypto company → the Crypto.com partnership and reach. An investor → the growth trajectory and impression numbers. A media/creator → the reach and QT/reshare social proof.

Rules:
- Open with their name and a specific, genuine reference to their company or what they're building — not generic flattery.
- ${track === 'guest'
    ? 'This person fits best as a GUEST: make the ask about coming on the show, not sponsorship. Keep the same voice; lean on proof points that show audience quality and reach.'
    : 'Make the ask about sponsorship / partnership, as in the template.'}
- Keep it tight and skimmable, one clear ask: a short intro chat.
- Sound like a real person, not marketing. No hype words, no "I hope this finds you well".
- Sign off as ${s.hostName || 'the host'}.
- ${channel === 'email'
    ? 'This is an email: also write a short, specific subject line.'
    : 'This is a DM: set subject to null and keep it a touch shorter than the email version.'}`;

  const user = `Recipient:
${leadPrompt(lead)}
${lead.aiCompany ? `Company: ${lead.aiCompany}` : ''}
${lead.aiRole ? `Role: ${lead.aiRole}` : ''}
${lead.aiReasoning ? `Why they're a fit: ${lead.aiReasoning}` : ''}
${(lead.aiHooks || []).length ? `Personalization hooks: ${(lead.aiHooks || []).join(' | ')}` : ''}`;

  const shape = (parsed: any): OutreachMessage => ({
    subject: parsed.subject ? String(parsed.subject) : null,
    message: String(parsed.message || ''),
    chosenPoints: Array.isArray(parsed.chosen_points) ? parsed.chosen_points.map(String) : []
  });

  if (s.provider === 'openai') {
    const sys = `${system}

Respond with ONLY a JSON object: {"subject": string|null, "message": string, "chosen_points": string[]}. No prose, no markdown fences.`;
    return shape(extractJson(await openaiChat(s, { system: sys, user, schema: OUTREACH_SCHEMA, maxTokens: 2000 })));
  }

  const response = await anthropicClient(s).messages.create({
    model: s.model || 'claude-opus-4-8', max_tokens: 2500,
    system,
    output_config: { format: { type: 'json_schema', schema: OUTREACH_SCHEMA } },
    messages: [{ role: 'user', content: user }]
  });
  await recordAiUsage(s.userId, 'message', 'anthropic', s.model || 'claude-opus-4-8', response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`No text returned (stop_reason: ${response.stop_reason})`);
  return shape(JSON.parse(text.text));
}

export async function generateEmailDraft(s: ResolvedSettings, lead: Lead, track: 'guest' | 'sponsor') {
  const hooks = (lead.aiHooks || []);
  const signoff = s.hostName || s.showName || 'the host';
  const system = `You write short, personalized cold outreach emails on behalf of a show host.

${showContext(s)}

Rules: under 120 words. Plain text only — no HTML, no bullet lists. Open with something specific about them, never "I hope this finds you well". One clear ask with an easy yes. No buzzwords or flattery padding. Sign off as ${signoff}.`;
  const user = `Write an email inviting this person to ${track === 'sponsor' ? 'explore sponsoring the show' : 'come on the show as a guest'}.

${leadPrompt(lead)}
${lead.aiCompany ? `Company: ${lead.aiCompany}` : ''}
${lead.aiRole ? `Role: ${lead.aiRole}` : ''}
${hooks.length ? `Personalization hooks: ${hooks.join(' | ')}` : ''}`;

  if (s.provider === 'openai') {
    const sys = `${system}

Respond with ONLY a JSON object: {"subject": string, "body": string}. No prose, no markdown fences.`;
    const parsed = extractJson(await openaiChat(s, { system: sys, user, schema: EMAIL_SCHEMA, maxTokens: 1024 }));
    return { subject: String(parsed.subject || ''), body: String(parsed.body || '') };
  }

  const response = await anthropicClient(s).messages.create({
    model: s.model || 'claude-opus-4-8', max_tokens: 2048,
    system,
    output_config: { format: { type: 'json_schema', schema: EMAIL_SCHEMA } },
    messages: [{ role: 'user', content: user }]
  });
  await recordAiUsage(s.userId, 'email_draft', 'anthropic', s.model || 'claude-opus-4-8', response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`No text returned (stop_reason: ${response.stop_reason})`);
  const parsed = JSON.parse(text.text);
  return { subject: String(parsed.subject || ''), body: String(parsed.body || '') };
}
