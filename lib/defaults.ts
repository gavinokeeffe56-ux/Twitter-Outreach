// Default natural-language target — what the AI hunts your list for. Editable up front.
export const DEFAULT_TARGET =
  'Category-leading technology or startup companies — across AI, dev tools, fintech, crypto, or infrastructure — that would be a strong sponsor for the show. Founders, CEOs, or senior operators with budget and an audience overlap.';

// Seed content for the outreach message drafter. These become the default
// template + proof-point pool for a new workspace; each user can edit them in
// Settings. Pre-filled with MTS so the drafter works out of the box.

export const DEFAULT_DM_TEMPLATE = `Hey [name] — Gavin here from MTS (Monitoring the Situation), the fastest-growing show on X covering AI, tech & markets. Since launching 14 weeks ago:

[proof points]

We're lining up sponsors for Q4 and the 2027 cohort — worth a quick chat about partnering? Would love to send more.`;

export const DEFAULT_EMAIL_TEMPLATE = `Hi [name],

This is Gavin from MTS (Monitoring the Situation), a techno-optimist X-native daily livestreaming show & podcast. We're the fastest-growing show on X covering AI, tech, and markets. Since launching 14 weeks ago:

[proof points]

The team, led by Chris Bakke and Natalie Toren, is currently meeting with potential sponsors for Q4 and the 2027 cohort. Would you be interested in chatting with us about partnership opportunities?

Best,
Gavin O'Keeffe`;

export const DEFAULT_MESSAGE_TEMPLATE = `Hi [name],

This is Gavin from MTS (Monitoring the Situation), a techno-optimist X-native daily livestreaming show & podcast. We're the fastest-growing show on X covering AI, tech, and markets. Since launching 14 weeks ago:

• 250K+ followers on X
• 2M daily X impressions
• 1M views on a single drop (our data microsites) — e.g. Musk v. Altman
• H2 2027 presenting partners: Databricks, ElevenLabs, Crypto.com + more
• QTs / reshares from Marc Andreessen, Bryan Johnson, Tobi Lütke, Balaji + more

The team, led by Chris Bakke and Natalie Toren, is currently meeting with potential sponsors for Q4 and the 2027 cohort. Would you be interested in chatting with us about partnership opportunities?

Best,
Gavin O'Keeffe`;

export const DEFAULT_PROOF_POINTS: string[] = [
  'Scaled from 0 to 250,000 followers on X since launching in late April',
  'Projecting 600K+ followers by end of year',
  'Interviewed 400+ guests, including CEOs of Robinhood, Vercel, Hugging Face, Box, Boom Supersonic, and Nous Research, plus regular appearances from frontier-lab researchers',
  'Guest highlight clips generate ~5M impressions/month (a recent Dr. Mike Israetel clip hit 1M)',
  'Presenting partners include Databricks, Crypto.com, and ElevenLabs, with more category-leading partners joining next month',
  'QTs / reshares from Marc Andreessen, Bryan Johnson, Tobi Lütke, Lisan Al-Gaib, and Balaji Srinivasan',
  'Reaches founders, CEOs, technical leaders, AI researchers, engineers, investors, and policy leaders seeking deeply technical, real-time analysis',
  'Shipped 23 Drops, several with 1M+ impressions (e.g. Musk v. Altman, Economics of Data Centers)',
  'Filmed in-studio in San Francisco — our mission is to chronicle the singularity and the people who matter',
  'Fastest-growing media company on X, outperforming TechCrunch and TBPN',
  '2M daily X impressions, with 1M views on a single drop'
];
