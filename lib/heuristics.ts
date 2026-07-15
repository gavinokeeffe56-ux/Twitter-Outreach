// Free, instant first-pass scoring of a bio: how likely is this person a
// startup founder/operator worth qualifying with the AI pass?

const SIGNALS: [RegExp, number, string][] = [
  [/\bco[- ]?founder\b/i, 35, 'co-founder'],
  [/\bfounder\b/i, 30, 'founder'],
  [/\bceo\b/i, 25, 'CEO'],
  [/\bcto\b/i, 20, 'CTO'],
  [/\bcoo\b|\bcpo\b|\bcmo\b/i, 15, 'C-suite'],
  [/\bbuilding\b|\bbuilt\b/i, 15, 'building something'],
  [/\by ?combinator\b|\byc\b[^a-z]|\b[ws]\d{2}\b/i, 25, 'YC'],
  [/\braised\b|\bseed\b|\bseries [ab]\b|\bpre[- ]seed\b|\bfunded\b/i, 20, 'funding'],
  [/\bbootstrapped?\b/i, 15, 'bootstrapped'],
  [/\bindie ?hacker\b|\bsolopreneur\b/i, 15, 'indie hacker'],
  [/\bsaas\b/i, 15, 'SaaS'],
  [/\bstartup\b/i, 12, 'startup'],
  [/\blaunch(ed|ing)?\b/i, 10, 'launching'],
  [/\bmrr\b|\barr\b/i, 15, 'revenue metrics'],
  [/\bexit(ed)?\b|\bacquired\b/i, 15, 'exit'],
  [/\bceo @|\bfounder @|@ ?[a-z0-9_]+\.(com|io|ai|co|app)\b/i, 10, 'company link'],
  [/\bhiring\b/i, 8, 'hiring'],
  [/\bproduct\b/i, 5, 'product'],
  [/\binvestor\b|\bangel\b|\bvc\b/i, 8, 'investor'],
  [/\bagency\b|\bstudio\b|\bconsultanc/i, 12, 'agency/studio'],
  [/\brun (a|an|my)\b|\bi run\b|\bowner\b/i, 10, 'business owner'],
  [/\bcreator\b|\bnewsletter\b|\bpodcast\b/i, 6, 'creator']
];

export function scoreLead(lead: { bio?: string | null; website?: string | null; followers?: number | null }) {
  const bio = lead.bio || '';
  let score = 0;
  const signals: string[] = [];
  for (const [re, weight, label] of SIGNALS) {
    if (re.test(bio)) { score += weight; signals.push(label); }
  }
  if (lead.website) score += 8;
  const f = Number(lead.followers) || 0;
  if (f >= 1000) score += 3;
  if (f >= 10000) score += 4;
  if (f >= 100000) score += 3;
  return { score: Math.min(100, score), signals };
}
