'use client';

import { useState } from 'react';

export interface Lead {
  id: number; handle: string; xUserId?: string | null; name?: string | null; bio?: string | null;
  followers?: number | null; website?: string | null; location?: string | null;
  email?: string | null; emailSource?: string | null; emailDraft?: { subject: string; body: string } | null; gmailDraftId?: string | null;
  hScore: number; hSignals: string[]; aiFit?: string | null; aiScore?: number | null;
  aiCompany?: string | null; aiRole?: string | null; aiReasoning?: string | null; aiHooks?: string[] | null;
  aiConfidence?: string | null; aiEvidence?: string | null;
  classifiedAt?: string | null; stage: string; notes: string; draft?: string | null;
}

const fmtNum = (n?: number | null) => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n);
const scoreClass = (n?: number | null) => (n ?? 0) >= 60 ? 'hi' : (n ?? 0) >= 30 ? 'mid' : 'lo';

async function api(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => {});
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
}

export default function LeadDrawer({ lead, onChanged }: { lead: Lead; onChanged: () => void }) {
  const [draft, setDraft] = useState(lead.draft || '');
  const [email, setEmail] = useState(lead.email || '');
  const [emailSource, setEmailSource] = useState(lead.emailSource && lead.email ? `found via ${lead.emailSource}` : '');
  const [subject, setSubject] = useState(lead.emailDraft?.subject || '');
  const [body, setBody] = useState(lead.emailDraft?.body || '');
  const [notes, setNotes] = useState(lead.notes || '');
  const [busy, setBusy] = useState('');
  const [gmailSaved, setGmailSaved] = useState(Boolean(lead.gmailDraftId));
  const [contacted, setContacted] = useState(lead.stage === 'contacted');
  const [chosenPoints, setChosenPoints] = useState<string[]>([]);
  const hooks = lead.aiHooks || [];

  const patch = (fields: Record<string, unknown>) => api(`/api/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify(fields) });

  const genMessage = async (channel: 'dm' | 'email') => {
    setBusy(`msg-${channel}`);
    try {
      const r = await api(`/api/message/${lead.id}`, { method: 'POST', body: JSON.stringify({ channel }) });
      setChosenPoints(r.chosenPoints || []);
      if (channel === 'email') { setSubject(r.subject || ''); setBody(r.message); }
      else { setDraft(r.message); }
    } catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  const genDraft = async (track: 'guest' | 'sponsor') => {
    setBusy(`dm-${track}`);
    try { const r = await api(`/api/draft/${lead.id}`, { method: 'POST', body: JSON.stringify({ track }) }); setDraft(r.draft); }
    catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  const dmUrl = /^\d+$/.test(String(lead.xUserId || ''))
    ? `https://x.com/messages/compose?recipient_id=${lead.xUserId}`
    : `https://x.com/${lead.handle}`;

  const copyOpenDM = async () => {
    copyText(draft);
    window.open(dmUrl, '_blank', 'noopener');
    try { await patch({ stage: 'contacted' }); setContacted(true); onChanged(); } catch (e) { alert((e as Error).message); }
  };

  const findEmail = async () => {
    setBusy('find');
    try {
      const r = await api(`/api/email/find/${lead.id}`, { method: 'POST' });
      if (r.email) { setEmail(r.email); setEmailSource(`found via ${r.source}`); }
      else setEmailSource('nothing found in bio or website');
    } catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  const genEmail = async (track: 'guest' | 'sponsor') => {
    setBusy(`em-${track}`);
    try { const d = await api(`/api/email/draft/${lead.id}`, { method: 'POST', body: JSON.stringify({ track }) }); setSubject(d.subject); setBody(d.body); }
    catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  const sendEmail = async () => {
    if (!email.trim()) return alert('No email address yet — click Find email first, or paste one in.');
    copyText(subject ? `Subject: ${subject}\n\n${body}` : body);
    window.open(`mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    try { await patch({ stage: 'contacted' }); setContacted(true); onChanged(); } catch (e) { alert((e as Error).message); }
  };

  const saveGmail = async () => {
    if (!email.trim()) return alert('No email address yet.');
    if (!body.trim()) return alert('Write or generate the email body first.');
    setBusy('gmail');
    try { await api(`/api/gmail/draft/${lead.id}`, { method: 'POST', body: JSON.stringify({ email: email.trim(), subject, body }) }); setGmailSaved(true); }
    catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  return (
    <aside className="drawer">
      <h2>@{lead.handle}</h2>
      <div className="muted">{lead.name} · {fmtNum(lead.followers)} followers {lead.location ? `· ${lead.location}` : ''}</div>
      {lead.website ? <div><a href={lead.website} target="_blank" rel="noopener noreferrer">{lead.website}</a></div> : null}

      <div className="section"><h4>Bio</h4><div>{lead.bio || '(empty)'}</div></div>

      <div className="section"><h4>AI verdict</h4>
        {lead.classifiedAt ? (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`badge ${lead.aiFit}`}>{lead.aiFit}</span>
              <span className={`score ${scoreClass(lead.aiScore)}`}>{lead.aiScore}/100</span>
              {lead.aiConfidence ? <span className={`conf conf-${lead.aiConfidence}`}>{lead.aiConfidence} confidence</span> : null}
            </div>
            {lead.aiCompany ? <div style={{ marginTop: 6 }}><b>{lead.aiCompany}</b>{lead.aiRole ? ` — ${lead.aiRole}` : ''}</div> : null}
            <p className="muted" style={{ fontSize: 13 }}>{lead.aiReasoning}</p>
            {lead.aiEvidence ? <div className="evidence"><strong>Evidence:</strong> {lead.aiEvidence}</div> : null}
            <div>{hooks.map((h, i) => <span key={i} className="hook">{h}</span>)}</div>
          </>
        ) : <span className="muted">Not classified yet</span>}
      </div>

      <div className="section" style={{ background: 'var(--accent-soft)', margin: '16px -8px 0', padding: '12px', borderRadius: 10 }}>
        <h4>✨ Personalized message <span className="muted">from your template</span></h4>
        <p className="muted" style={{ marginTop: 0 }}>Picks the proof points most relevant to this person and writes the message into the DM or email fields below.</p>
        <div className="drawer-actions" style={{ marginTop: 0 }}>
          <button className="btn primary small" disabled={busy === 'msg-dm'} onClick={() => genMessage('dm')}>{busy === 'msg-dm' ? 'Writing…' : '✨ Generate DM'}</button>
          <button className="btn primary small" disabled={busy === 'msg-email'} onClick={() => genMessage('email')}>{busy === 'msg-email' ? 'Writing…' : '✨ Generate email'}</button>
        </div>
        {chosenPoints.length > 0 && (
          <div className="muted" style={{ marginTop: 10 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>Proof points it chose for them:</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{chosenPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="section"><h4>DM draft {contacted ? '· Contacted ✓' : ''}</h4>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => patch({ draft })} placeholder="No draft yet — generate one below." />
        <div className="drawer-actions">
          <button className="btn ghost small" disabled={busy === 'dm-guest'} onClick={() => genDraft('guest')}>{busy === 'dm-guest' ? 'Writing…' : '✨ Draft guest invite'}</button>
          <button className="btn ghost small" disabled={busy === 'dm-sponsor'} onClick={() => genDraft('sponsor')}>{busy === 'dm-sponsor' ? 'Writing…' : '✨ Draft sponsor pitch'}</button>
        </div>
        <div className="drawer-actions">
          <button className="btn primary small" onClick={copyOpenDM}>📋 Copy &amp; open DM → Contacted</button>
          <button className="btn ghost small" onClick={() => copyText(draft)}>Copy</button>
          <a className="btn ghost small" href={`https://x.com/${lead.handle}`} target="_blank" rel="noopener noreferrer">Open profile ↗</a>
        </div>
        <p className="muted">{/^\d+$/.test(String(lead.xUserId || ''))
          ? 'Opens straight into their DM composer — paste (⌘V) and send.'
          : 'No numeric user ID in your CSV, so this opens their profile — click Message there, then paste.'}</p>
      </div>

      <div className="section"><h4>Email track</h4>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => patch({ email: email.trim() })} placeholder="No email yet — click Find email, or paste one" />
        <span className="muted">{emailSource}</span>
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => patch({ email_draft: { subject, body } })} placeholder="Subject" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => patch({ email_draft: { subject, body } })} placeholder="Email body — generate below or write your own." />
        <div className="drawer-actions">
          <button className="btn ghost small" disabled={busy === 'find'} onClick={findEmail}>{busy === 'find' ? 'Scanning…' : '🔎 Find email'}</button>
          <button className="btn ghost small" disabled={busy === 'em-guest'} onClick={() => genEmail('guest')}>{busy === 'em-guest' ? 'Writing…' : '✨ Draft guest email'}</button>
          <button className="btn ghost small" disabled={busy === 'em-sponsor'} onClick={() => genEmail('sponsor')}>{busy === 'em-sponsor' ? 'Writing…' : '✨ Draft sponsor email'}</button>
        </div>
        <div className="drawer-actions">
          <button className="btn primary small" onClick={sendEmail}>📧 Copy &amp; open email → Contacted</button>
          <button className="btn ghost small" disabled={busy === 'gmail' || gmailSaved} onClick={saveGmail}>{gmailSaved ? '✓ In Gmail Drafts' : busy === 'gmail' ? 'Saving…' : '💾 Save to Gmail Drafts'}</button>
        </div>
      </div>

      <div className="section"><h4>Notes</h4>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => patch({ notes })} />
      </div>
    </aside>
  );
}
