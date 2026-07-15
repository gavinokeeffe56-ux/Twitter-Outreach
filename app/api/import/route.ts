import { NextResponse } from 'next/server';
import { parse } from 'csv-parse/sync';
import { sql } from 'drizzle-orm';
import { db, leads } from '@/lib/db';
import { requireUser, isResponse } from '@/lib/api';
import { scoreLead } from '@/lib/heuristics';

export const maxDuration = 60;

const COLUMN_ALIASES: Record<string, string[]> = {
  handle: ['handle', 'username', 'screenname', 'screen_name', 'user_name', 'twitterhandle', 'account', 'profile'],
  xUserId: ['userid', 'user_id', 'twitterid', 'twitter_id', 'restid', 'rest_id', 'accountid', 'account_id', 'id'],
  name: ['name', 'displayname', 'display_name', 'fullname', 'full_name'],
  bio: ['bio', 'description', 'about', 'profile_description'],
  followers: ['followers', 'followerscount', 'followers_count', 'follower_count', 'numfollowers'],
  website: ['website', 'url', 'expandedurl', 'expanded_url', 'link', 'site'],
  location: ['location', 'city', 'country'],
  email: ['email', 'emailaddress', 'email_address', 'contactemail', 'contact_email']
};

const norm = (h: string) => String(h || '').toLowerCase().replace(/[^a-z0-9_]/g, '');

export async function POST(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;

  const csvText = await req.text();
  if (!csvText.trim()) return NextResponse.json({ error: 'Empty file.' }, { status: 400 });

  let records: Record<string, string>[];
  try {
    records = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
  } catch (err) {
    return NextResponse.json({ error: `CSV parse failed: ${(err as Error).message}` }, { status: 400 });
  }
  if (!records.length) return NextResponse.json({ error: 'No rows found in CSV.' }, { status: 400 });

  const headers = Object.keys(records[0]);
  const normalized = headers.map(norm);
  const mapping: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx !== -1) mapping[field] = headers[idx];
  }
  if (!mapping.handle) {
    return NextResponse.json({ error: `Couldn't find a username/handle column. Detected: ${headers.join(', ')}` }, { status: 400 });
  }

  const rows = [];
  for (const row of records) {
    const handle = String(row[mapping.handle] || '').replace(/^@/, '').trim();
    if (!handle) continue;
    const bio = mapping.bio ? String(row[mapping.bio] || '').trim() : null;
    const website = mapping.website ? String(row[mapping.website] || '').trim() : null;
    const followers = mapping.followers ? parseInt(String(row[mapping.followers]).replace(/[^0-9]/g, ''), 10) || 0 : null;
    const rawEmail = mapping.email ? String(row[mapping.email] || '').trim().toLowerCase() : '';
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
    const { score, signals } = scoreLead({ bio, website, followers });
    rows.push({
      ownerId: user,
      handle,
      xUserId: mapping.xUserId ? String(row[mapping.xUserId] || '').trim() || null : null,
      name: mapping.name ? String(row[mapping.name] || '').trim() : null,
      bio, followers, website,
      location: mapping.location ? String(row[mapping.location] || '').trim() : null,
      email, emailSource: email ? 'csv' : null,
      hScore: score, hSignals: signals
    });
  }

  // Batch insert; ignore rows that collide on (owner, handle).
  let imported = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await db.insert(leads).values(slice)
      .onConflictDoNothing({ target: [leads.ownerId, leads.handle] })
      .returning({ id: leads.id });
    imported += res.length;
  }

  return NextResponse.json({ imported, skipped: records.length - imported, total: records.length, mapping });
}
