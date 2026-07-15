import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { accounts } from './db/schema';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Google-account tokens are stored by Auth.js in the `account` table. We refresh
// the short-lived access token on demand using the stored refresh_token.
export async function getGmailAccessToken(userId: string): Promise<string> {
  const acct = (await db.select().from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .limit(1))[0];
  if (!acct) throw new Error('No Google account linked.');

  // Reuse a still-valid access token if we have one.
  if (acct.access_token && acct.expires_at && acct.expires_at * 1000 > Date.now() + 60_000) {
    return acct.access_token;
  }
  if (!acct.refresh_token) {
    throw new Error('Gmail access not granted — sign out and sign in again to grant Gmail permission.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new Error('Gmail permission expired — sign out and back in to reconnect.');
    throw new Error(`Gmail token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  const expires_at = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  await db.update(accounts).set({ access_token: data.access_token, expires_at })
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')));
  return data.access_token;
}

const encodeSubject = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

export async function createGmailDraft(userId: string, msg: { to: string; subject: string; body: string }): Promise<string> {
  const token = await getGmailAccessToken(userId);
  const raw = Buffer.from([
    `To: ${msg.to}`,
    `Subject: ${encodeSubject(msg.subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.body || ''
  ].join('\r\n'), 'utf8').toString('base64url');

  const res = await fetch(`${API_BASE}/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail draft failed: ${data.error?.message || res.status}`);
  return data.id as string;
}
