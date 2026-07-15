import type { ResolvedSettings } from './settings';
import type { Lead } from './db/schema';
import { recordLookup } from './usage';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JUNK_RE = /(example\.|yourdomain|yoursite|sentry|wixpress|godaddy|cloudflare|no-?reply|donotreply|@2x|\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$)/i;
const JUNK_LOCAL = new Set(['your', 'you', 'name', 'email', 'user', 'hello@example', 'someone', 'info@example']);
const GENERIC_DOMAINS = new Set(['linktr.ee', 'twitter.com', 'x.com', 't.co', 'youtube.com', 'instagram.com', 'facebook.com', 'linkedin.com', 'medium.com', 'github.com', 'bit.ly', 'linkin.bio']);

export interface EmailResult { email: string; source: string; }

export function emailsFromText(text: string | null | undefined): string[] {
  const decoded = String(text || '').replace(/%40/gi, '@').replace(/mailto:/gi, ' ');
  const found = (decoded.match(EMAIL_RE) || [])
    .map((e) => e.toLowerCase().replace(/^[.,;:]+|[.,;:]+$/g, ''))
    .filter((e) => !JUNK_RE.test(e) && !JUNK_LOCAL.has(e.split('@')[0]));
  return [...new Set(found)];
}

function toUrl(website: string | null | undefined): URL | null {
  if (!website) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

async function fetchPage(url: string, timeoutMs = 6000): Promise<{ html: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; outreach-pipeline/1.0)' } });
    if (!res.ok) return { html: '', finalUrl: url };
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain/i.test(type)) return { html: '', finalUrl: res.url || url };
    return { html: (await res.text()).slice(0, 500_000), finalUrl: res.url || url };
  } catch {
    return { html: '', finalUrl: url };
  } finally {
    clearTimeout(t);
  }
}

export async function emailFromWebsite(website: string | null | undefined): Promise<EmailResult | null> {
  const base = toUrl(website);
  if (!base) return null;
  const home = await fetchPage(base.href);
  let siteDomain: string;
  try { siteDomain = new URL(home.finalUrl).hostname.replace(/^www\./, ''); } catch { siteDomain = base.hostname.replace(/^www\./, ''); }

  let emails = emailsFromText(home.html);
  if (!emails.length && home.finalUrl) {
    let origin: string;
    try { origin = new URL(home.finalUrl).origin; } catch { origin = base.origin; }
    for (const path of ['/contact', '/about']) {
      const page = await fetchPage(origin + path);
      emails = emailsFromText(page.html);
      if (emails.length) break;
    }
  }
  if (!emails.length) return null;
  emails.sort((a, b) => {
    const aOwn = a.endsWith('@' + siteDomain) || a.endsWith('.' + siteDomain) ? 0 : 1;
    const bOwn = b.endsWith('@' + siteDomain) || b.endsWith('.' + siteDomain) ? 0 : 1;
    return aOwn - bOwn || a.length - b.length;
  });
  return { email: emails[0], source: 'website' };
}

// Pull a company's homepage as plain text, to ground the AI's judgment in real
// data instead of a 160-char bio. Timeout-bounded and truncated for cost/speed.
export async function fetchWebsiteText(website: string | null | undefined): Promise<string> {
  const base = toUrl(website);
  if (!base) return '';
  const { html } = await fetchPage(base.href, 5000);
  if (!html) return '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 2500);
}

async function hunterFind(s: ResolvedSettings, lead: Lead): Promise<EmailResult | null> {
  if (!s.hunterKey || !lead.website) return null;
  const base = toUrl(lead.website);
  if (!base) return null;
  const domain = base.hostname.replace(/^www\./, '');
  if (GENERIC_DOMAINS.has(domain)) return null;
  await recordLookup(s.userId, 'hunter');
  try {
    if (lead.name && lead.name.trim().includes(' ')) {
      const u = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&full_name=${encodeURIComponent(lead.name.trim())}&api_key=${s.hunterKey}`;
      const d = await (await fetch(u)).json();
      if (d.data?.email && (d.data.score ?? 0) >= 50) return { email: String(d.data.email).toLowerCase(), source: `hunter ${d.data.score}%` };
    }
    const u = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=3&api_key=${s.hunterKey}`;
    const d = await (await fetch(u)).json();
    const first = (d.data?.emails || []).find((e: any) => e.value);
    if (first) return { email: String(first.value).toLowerCase(), source: `hunter ${first.confidence ?? '?'}%` };
  } catch { /* hunter down or out of credits */ }
  return null;
}

async function tombaFind(s: ResolvedSettings, lead: Lead): Promise<EmailResult | null> {
  if (!s.tombaKey || !s.tombaSecret || !lead.website) return null;
  const base = toUrl(lead.website);
  if (!base) return null;
  const domain = base.hostname.replace(/^www\./, '');
  if (GENERIC_DOMAINS.has(domain)) return null;
  const headers = { 'X-Tomba-Key': s.tombaKey, 'X-Tomba-Secret': s.tombaSecret };
  await recordLookup(s.userId, 'tomba');
  try {
    if (lead.name && lead.name.trim().includes(' ')) {
      const u = `https://api.tomba.io/v1/email-finder/${encodeURIComponent(domain)}?full_name=${encodeURIComponent(lead.name.trim())}`;
      const d = await (await fetch(u, { headers })).json();
      if (d.data?.email && (d.data.score ?? 0) >= 50) return { email: String(d.data.email).toLowerCase(), source: `tomba ${d.data.score}%` };
    }
    const u = `https://api.tomba.io/v1/domain-search/${encodeURIComponent(domain)}?limit=3`;
    const d = await (await fetch(u, { headers })).json();
    const first = (d.data?.emails || []).find((e: any) => e.email);
    if (first) return { email: String(first.email).toLowerCase(), source: 'tomba' };
  } catch { /* tomba down or out of credits */ }
  return null;
}

export async function findEmailForLead(s: ResolvedSettings, lead: Lead): Promise<EmailResult | null> {
  const fromBio = emailsFromText(lead.bio);
  if (fromBio.length) return { email: fromBio[0], source: 'bio' };
  const fromSite = await emailFromWebsite(lead.website);
  if (fromSite) return fromSite;
  const fromHunter = await hunterFind(s, lead);
  if (fromHunter) return fromHunter;
  return tombaFind(s, lead);
}
