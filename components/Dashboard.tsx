'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import LeadDrawer, { type Lead } from './LeadDrawer';
import { Icon } from './icons';

const STAGES: [string, string][] = [
  ['new', 'New'], ['qualified', 'Qualified'], ['contacted', 'Contacted'],
  ['responded', 'Responded'], ['booked', 'Booked'], ['passed', 'Passed']
];

async function api(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtNum = (n?: number | null) =>
  n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n);
export const scoreClass = (n?: number | null) => (n ?? 0) >= 60 ? 'hi' : (n ?? 0) >= 30 ? 'mid' : 'lo';

interface Props { userEmail: string; userImage: string; signOutAction: () => Promise<void>; }
type View = 'leads' | 'board' | 'dm' | 'email' | 'api' | 'usage';
interface Filters { search: string; stage: string; fit: string; classified: string; sort: string; strong: string; }
interface JobState { status: string; total: number; done: number; found: number; drafted: number; errors: number; lastError: string | null; }

export default function Dashboard({ userEmail, userImage, signOutAction }: Props) {
  const [view, setView] = useState<View>('leads');
  const [stats, setStats] = useState<{ total: number; classified: number; withEmail: number } | null>(null);
  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({ search: '', stage: '', fit: '', classified: '', sort: 'ai_score', strong: '' });
  const [openLead, setOpenLead] = useState<Lead | null>(null);
  const [target, setTarget] = useState('');
  const [showName, setShowName] = useState('');
  const [showDesc, setShowDesc] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [findEst, setFindEst] = useState<{ count: number; cost: number | null; model: string } | null>(null);
  const [banner, setBanner] = useState<{ kind: string; job: JobState } | null>(null);
  const [showImport, setShowImport] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeKind = useRef<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const s = await api('/api/stats');
      setStats(s);
      setShowImport(s.total === 0);
    } catch { /* ignore */ }
  }, []);

  const loadLeads = useCallback(async () => {
    const p = new URLSearchParams({ page: String(page), pageSize: '100', sort: filters.sort });
    if (filters.search) p.set('search', filters.search);
    if (filters.stage) p.set('stage', filters.stage);
    if (filters.fit) p.set('fit', filters.fit);
    if (filters.classified) p.set('classified', filters.classified);
    if (filters.strong) p.set('strong', filters.strong);
    const data = await api(`/api/leads?${p}`);
    setRows(data.rows); setTotal(data.total);
  }, [page, filters]);

  const refresh = useCallback(() => { loadStats(); if (view === 'leads') loadLeads(); }, [loadStats, loadLeads, view]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { if (view === 'leads') loadLeads(); }, [view, loadLeads]);

  // Finder: load the saved search context, and a running cost estimate.
  useEffect(() => {
    api('/api/settings').then((s) => { setTarget(s.targetDescription || ''); setShowName(s.showName || ''); setShowDesc(s.showDescription || ''); }).catch(() => {});
  }, []);
  const refreshFindEst = useCallback(async () => {
    try { const e = await api('/api/classify?minHScore=15&limit=1500'); setFindEst({ count: e.count, cost: e.estimatedCostUSD ?? null, model: e.model }); }
    catch { setFindEst(null); }
  }, []);
  useEffect(() => { refreshFindEst(); }, [stats, refreshFindEst]);

  // ---- job polling ----
  const watchJob = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const jobs = await api('/api/jobs');
      const running = jobs.classify.status === 'running' ? ['classify', jobs.classify]
        : jobs.email.status === 'running' ? ['email', jobs.email]
        : jobs.gmail.status === 'running' ? ['gmail', jobs.gmail] : null;
      if (running) {
        activeKind.current = running[0] as string;
        setBanner({ kind: running[0] as string, job: running[1] as JobState });
      } else {
        if (banner) {
          const j: JobState = activeKind.current === 'email' ? jobs.email : activeKind.current === 'gmail' ? jobs.gmail : jobs.classify;
          if (j.status === 'error') alert(`Job stopped: ${j.lastError}`);
          else if (activeKind.current === 'email') alert(`Email hunt finished — found ${j.found} of ${j.total} scanned.`);
          else if (activeKind.current === 'gmail') alert(`Gmail push finished — ${j.drafted} of ${j.total} saved to Drafts${j.errors ? ` (${j.errors} errors)` : ''}.`);
          setBanner(null);
          refresh();
        }
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        activeKind.current = null;
      }
    }, 1500);
  }, [banner, refresh]);

  useEffect(() => { watchJob(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []); // eslint-disable-line

  // ---- import ----
  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(`Imported ${data.imported.toLocaleString()} leads (${data.skipped} duplicates/blank skipped).`);
      await loadStats(); await loadLeads();
    } catch (err) { alert((err as Error).message); }
  };

  const stopJob = () =>
    api(activeKind.current === 'email' ? '/api/email/hunt' : activeKind.current === 'gmail' ? '/api/gmail/push' : '/api/classify', { method: 'DELETE' });

  const huntEmails = async () => {
    try {
      const est = await api('/api/email/hunt');
      if (!est.count) return alert('No leads left to hunt.');
      const method = est.hunterEnabled ? 'bio + website scan + Hunter.io' : 'bio + website scan (add a Hunter.io key in Settings for deeper lookups)';
      if (!confirm(`Hunt emails for ${est.count.toLocaleString()} leads?\n\nMethod: ${method}. Prioritizes AI-qualified fits first.`)) return;
      await api('/api/email/hunt', { method: 'POST', body: '{}' });
      watchJob();
    } catch (err) { alert((err as Error).message); }
  };

  const pushGmail = async () => {
    try {
      const est = await api('/api/gmail/push');
      if (!est.connected) return alert('Gmail is not connected — sign out and back in to grant Gmail access.');
      if (!est.count) return alert('Nothing to push — no New/Qualified leads with an email left.');
      const note = est.needDrafts ? `\n\n${est.needDrafts} have no draft yet — the AI will write those first.` : '';
      if (!confirm(`Save ${est.count.toLocaleString()} emails to your Gmail Drafts?${note}\n\nNothing is sent — you review and send from Gmail.`)) return;
      await api('/api/gmail/push', { method: 'POST', body: '{}' });
      watchJob();
    } catch (err) { alert((err as Error).message); }
  };

  const runFind = async () => {
    if (!stats?.total) return alert('Import a list first, then describe who you\'re looking for.');
    try {
      // Save the search context (target + show), then kick off the grounded find.
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ targetDescription: target, showName, showDescription: showDesc }) });
      await api('/api/classify', { method: 'POST', body: JSON.stringify({ minHScore: 15, limit: 1500 }) });
      watchJob();
    } catch (err) { alert((err as Error).message); }
  };

  const NAV: [View, string, string][] = [
    ['leads', 'leads', 'Leads'], ['board', 'pipeline', 'Pipeline'],
    ['dm', 'dm', 'DM template'], ['email', 'email', 'Email template'],
    ['api', 'api', 'API hub'], ['usage', 'usage', 'Usage']
  ];
  const navBtn = ([v, ic, t]: [View, string, string]) => (
    <button key={v} className={`nav-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)}><span className="nav-ic"><Icon name={ic} /></span>{t}</button>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="side-brand">🎙️ Outreach</div>
        <nav className="side-nav">
          <div className="nav-group"><div className="nav-label">Workspace</div>{NAV.slice(0, 2).map(navBtn)}</div>
          <div className="nav-group"><div className="nav-label">Outreach</div>{NAV.slice(2, 4).map(navBtn)}</div>
          <div className="nav-group"><div className="nav-label">Config</div>{NAV.slice(4).map(navBtn)}</div>
        </nav>
        <div className="side-user">
          {userImage ? <img className="avatar" src={userImage} alt="" /> : null}
          <span className="side-email">{userEmail}</span>
          <form action={signOutAction}><button className="btn ghost small" type="submit">Sign out</button></form>
        </div>
      </aside>

      <div className="main-col">
        <div className="topbar">
          <h1 className="page-title">{NAV.find((n) => n[0] === view)?.[2]}</h1>
          <div className="topbar-actions">
            {stats?.total ? <span className="chip">{stats.total.toLocaleString()} leads · {stats.classified.toLocaleString()} analyzed</span> : null}
            <a href="/api/export" className="btn ghost small" download><Icon name="download" size={14} /> Export</a>
          </div>
        </div>

      {banner && (
        <div className="job-banner">
          <span>
            {banner.kind === 'classify' ? `Classifying: ${banner.job.done}/${banner.job.total}`
              : banner.kind === 'email' ? `Hunting emails: ${banner.job.done}/${banner.job.total} · ${banner.job.found} found`
              : `Pushing to Gmail: ${banner.job.done}/${banner.job.total} · ${banner.job.drafted} saved`}
          </span>
          <div className="progress"><div className="progress-bar" style={{ width: `${banner.job.total ? (banner.job.done / banner.job.total) * 100 : 0}%` }} /></div>
          <button className="btn ghost small" onClick={stopJob}>Stop</button>
        </div>
      )}

      {view === 'leads' && (
        <main className="view">
          {(showImport) && (
            <ImportZone onFile={importFile} onClose={() => setShowImport(false)} hasLeads={Boolean(stats?.total)} />
          )}
          <section className="hero">
            <h2>Who are you looking for?</h2>
            <p className="sub">Describe your ideal lead in plain English. The AI reads every profile — and each company&apos;s website — then ranks the best matches with evidence. Reach out by email or X DM in a couple of clicks.</p>
            <textarea value={target} onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. Category-leading AI, dev-tools, or fintech startups that would be a great sponsor for MTS" />
            <div className="hero-row">
              <button className="btn primary" onClick={runFind} disabled={!stats?.total || !target.trim()}><Icon name="sparkle" size={15} /> Find best leads</button>
              {!stats?.total ? <span className="est">↑ Import a list first</span>
                : findEst && findEst.count > 0 ? <span className="est">Analyzes {findEst.count.toLocaleString()} profiles{findEst.cost != null ? ` · est. ~$${findEst.cost}` : ''} · reads their websites · runs in the background</span>
                : findEst && findEst.count === 0 ? <span className="est">Every matching profile is already analyzed — sort by AI score below to see the best. Import more to find new ones.</span>
                : null}
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => setSetupOpen((o) => !o)}>{setupOpen ? 'Hide' : 'Edit'} show context</button>
            </div>
            {setupOpen && (
              <div className="search-setup">
                <label>Show name<input value={showName} onChange={(e) => setShowName(e.target.value)} placeholder="e.g. MTS — Monitoring the Situation" /></label>
                <label>What your show is &amp; who watches <span className="muted">(the AI judges fit against this — be specific)</span>
                  <textarea rows={3} value={showDesc} onChange={(e) => setShowDesc(e.target.value)} placeholder="What's the show about? Who's the audience?" /></label>
                <p className="muted" style={{ margin: 0 }}>Saved automatically when you run a find.</p>
              </div>
            )}
          </section>
          <section className="toolbar">
            <input type="search" placeholder="Search handle, name, bio…" value={filters.search}
              onChange={(e) => { setFilters((f) => ({ ...f, search: e.target.value })); setPage(1); }} />
            <select value={filters.stage} onChange={(e) => { setFilters((f) => ({ ...f, stage: e.target.value })); setPage(1); }}>
              <option value="">All stages</option>{STAGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <select value={filters.fit} onChange={(e) => { setFilters((f) => ({ ...f, fit: e.target.value })); setPage(1); }}>
              <option value="">All fits</option><option value="sponsor">Sponsor</option><option value="guest">Guest</option><option value="both">Both</option><option value="none">None</option>
            </select>
            <select value={filters.classified} onChange={(e) => { setFilters((f) => ({ ...f, classified: e.target.value })); setPage(1); }}>
              <option value="">All leads</option><option value="yes">Classified</option><option value="no">Not classified</option>
            </select>
            <select value={filters.sort} onChange={(e) => { setFilters((f) => ({ ...f, sort: e.target.value })); setPage(1); }}>
              <option value="ai_score">Sort: AI score</option><option value="h_score">Sort: Signal score</option><option value="followers">Sort: Followers</option><option value="handle">Sort: Handle</option>
            </select>
            <button className={`btn small ${filters.strong ? 'primary' : 'ghost'}`} onClick={() => { setFilters((f) => ({ ...f, strong: f.strong ? '' : 'yes' })); setPage(1); }}>
              {filters.strong ? <Icon name="check" size={13} /> : null}High-confidence only
            </button>
            <span className="spacer" />
            {stats?.total ? <button className="btn ghost small" onClick={() => setShowImport(true)}>+ Import</button> : null}
            <button className="btn ghost" onClick={huntEmails}><Icon name="search" size={14} /> Find emails</button>
            <button className="btn ghost" onClick={pushGmail}><Icon name="draft" size={14} /> Push to Gmail</button>
          </section>

          <section>
            <table>
              <thead><tr><th>Lead</th><th>Bio</th><th>Signals</th><th>Match</th><th>Stage</th><th></th></tr></thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={6} className="empty">No leads match. Import a CSV or adjust filters.</td></tr>
                ) : rows.map((l) => (
                  <tr key={l.id} onClick={() => setOpenLead(l)}>
                    <td>
                      <div className="lead-handle">@{l.handle}</div>
                      <div className="lead-name">{l.name}</div>
                      <div className="followers">{fmtNum(l.followers)} followers</div>
                    </td>
                    <td className="bio-cell">{(l.bio || '').slice(0, 180)}</td>
                    <td><span className={`score ${scoreClass(l.hScore)}`}>{l.hScore}</span>
                      <div className="muted">{(l.hSignals || []).slice(0, 3).join(', ')}</div></td>
                    <td>{l.classifiedAt ? <>
                      <div className="match-line"><span className={`badge ${l.aiFit}`}>{l.aiFit}</span> <span className={`score ${scoreClass(l.aiScore)}`}>{l.aiScore}</span></div>
                      {l.aiConfidence ? <span className={`conf conf-${l.aiConfidence}`}>{l.aiConfidence}</span> : null}
                    </> : <span className="muted">—</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select className="stage-select" value={l.stage}
                        onChange={async (e) => { await api(`/api/leads/${l.id}`, { method: 'PATCH', body: JSON.stringify({ stage: e.target.value }) }); refresh(); }}>
                        {STAGES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </select>
                    </td>
                    <td><div className="row-ic">{l.email ? <Icon name="email" size={15} /> : null}{l.draft ? <Icon name="dm" size={15} /> : null}{l.gmailDraftId ? <Icon name="draft" size={15} /> : null}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <span>Page {page} of {Math.max(1, Math.ceil(total / 100))} · {total.toLocaleString()} leads</span>
              <button className="btn ghost small" disabled={page >= Math.ceil(total / 100)} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          </section>
        </main>
      )}

      {view === 'board' && <Board onOpen={setOpenLead} onChanged={refresh} />}
      {view === 'dm' && <TemplatePanel channel="dm" />}
      {view === 'email' && <TemplatePanel channel="email" />}
      {view === 'api' && <ApiHubPanel />}
      {view === 'usage' && <main className="view"><UsagePanel /></main>}
      </div>

      {openLead && (
        <>
          <div className="drawer-backdrop" onClick={() => { setOpenLead(null); refresh(); }} />
          <LeadDrawer lead={openLead} onChanged={refresh} />
        </>
      )}
    </div>
  );
}

// ---- Import zone ----
function ImportZone({ onFile, onClose, hasLeads }: { onFile: (f: File) => void; onClose: () => void; hasLeads: boolean }) {
  const [drag, setDrag] = useState(false);
  return (
    <section className={`import-zone ${drag ? 'dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
      <div>
        <strong>Import your followers list</strong>
        <p>Drop a CSV export here (Circleboom, Followerwonk, twtData, or any CSV with a username column). Duplicates are skipped.</p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <label className="btn primary">Choose CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); }} /></label>
        {hasLeads ? <button className="btn ghost" onClick={onClose}>Close</button> : null}
      </div>
    </section>
  );
}

// ---- Board ----
function Board({ onOpen, onChanged }: { onOpen: (l: Lead) => void; onChanged: () => void }) {
  const [cols, setCols] = useState<Record<string, { rows: Lead[]; total: number }>>({});
  const load = useCallback(async () => {
    const out: Record<string, { rows: Lead[]; total: number }> = {};
    for (const [stage] of STAGES) {
      const d = await api(`/api/leads?stage=${stage}&pageSize=200&sort=ai_score`);
      out[stage] = { rows: d.rows, total: d.total };
    }
    setCols(out);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <main className="view">
      <div className="board">
        {STAGES.map(([stage, title]) => (
          <div key={stage} className="col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              const id = e.dataTransfer.getData('text/plain');
              await api(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
              load(); onChanged();
            }}>
            <h3>{title}<span>{cols[stage]?.total ?? 0}</span></h3>
            <div className="col-cards">
              {(cols[stage]?.rows || []).map((l) => (
                <div key={l.id} className="card" draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(l.id))}
                  onClick={() => onOpen(l)}>
                  <div className="lead-handle">@{l.handle}</div>
                  <div className="lead-name">{l.aiCompany || l.name}</div>
                  <div className="card-meta">
                    {l.aiFit ? <span className={`badge ${l.aiFit}`}>{l.aiFit}</span> : null}
                    <span className={`score ${scoreClass(l.aiScore ?? l.hScore)}`}>{l.aiScore ?? l.hScore}</span>
                    {l.email ? <Icon name="email" size={14} /> : null}{l.gmailDraftId ? <Icon name="draft" size={14} /> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

// ---- Template editor (DM / Email) with live preview ----
const SAMPLE_NAME = 'Sarah';

function TemplatePanel({ channel }: { channel: 'dm' | 'email' }) {
  const [loaded, setLoaded] = useState(false);
  const [tpl, setTpl] = useState('');
  const [points, setPoints] = useState<string[]>([]);
  const [count, setCount] = useState(4);
  const [hostName, setHostName] = useState('');
  const [saved, setSaved] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api('/api/settings').then((s) => {
      setTpl((channel === 'dm' ? s.dmTemplate : s.emailTemplate) || '');
      setPoints(s.proofPoints || []);
      setCount(s.proofPointCount || 4);
      setHostName(s.hostName || '');
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [channel]);

  const insert = (token: string) => {
    const ta = taRef.current;
    if (!ta) { setTpl(tpl + token); return; }
    const start = ta.selectionStart, end = ta.selectionEnd;
    setTpl(tpl.slice(0, start) + token + tpl.slice(end));
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + token.length; });
  };

  const save = async () => {
    const body: any = { proofPoints: points.filter((p) => p.trim()), proofPointCount: count };
    body[channel === 'dm' ? 'dmTemplate' : 'emailTemplate'] = tpl;
    if (channel === 'email') body.hostName = hostName;
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    setSaved('Saved ✓'); setTimeout(() => setSaved(''), 2000);
  };

  const preview = tpl
    .replace(/\[name\]/gi, SAMPLE_NAME)
    .replace(/\[proof points\]/gi, points.slice(0, count).map((p) => '• ' + p).join('\n'));

  if (!loaded) return <main className="view"><p className="muted">Loading…</p></main>;

  return (
    <main className="view">
      <div className="tpl-layout">
        <div className="tpl-editor">
          <p className="muted" style={{ marginTop: 0 }}>{channel === 'dm'
            ? 'Short template for X DMs. The AI personalizes it per person and picks the best proof points for them.'
            : 'Longer template for cold email. The AI also writes a specific subject line per recipient.'}</p>

          {channel === 'email' && (
            <div className="fld"><div className="fld-head"><span>Your name <span className="muted">(signs off emails &amp; DMs)</span></span></div>
              <input value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="e.g. Gavin O'Keeffe" /></div>
          )}

          <div className="fld">
            <div className="fld-head">
              <span>Template</span>
              <div className="token-btns">
                <button className="chip-btn" onClick={() => insert('[name]')}>+ [name]</button>
                <button className="chip-btn" onClick={() => insert('[proof points]')}>+ [proof points]</button>
              </div>
            </div>
            <textarea ref={taRef} rows={channel === 'dm' ? 9 : 13} value={tpl} onChange={(e) => setTpl(e.target.value)} placeholder="Write your template. Use the buttons above to drop in [name] and [proof points]." />
          </div>

          <div className="fld">
            <div className="fld-head"><span>Proof points <span className="muted">— the AI picks the best few per person</span></span></div>
            <div className="pp-list">
              {points.map((p, i) => (
                <div className="pp-row" key={i}>
                  <input value={p} onChange={(e) => { const c = [...points]; c[i] = e.target.value; setPoints(c); }} placeholder="A traction proof point…" />
                  <button className="pp-del" onClick={() => setPoints(points.filter((_, j) => j !== i))} title="Remove">✕</button>
                </div>
              ))}
              <button className="chip-btn" onClick={() => setPoints([...points, ''])}>+ Add proof point</button>
            </div>
            <label className="pp-count">Use <input type="number" min={1} max={8} value={count} onChange={(e) => setCount(Number(e.target.value))} /> per message</label>
          </div>

          <div className="tpl-save">
            <button className="btn primary" onClick={save}>Save template</button> <span className="muted">{saved}</span>
          </div>
        </div>

        <div className="tpl-preview">
          <div className="preview-label">Preview</div>
          <div className={`preview-card ${channel}`}>
            {channel === 'email' && <div className="preview-subject">Subject <span className="muted">— AI writes this per recipient</span></div>}
            <div className="preview-body">{preview || <span className="muted">Your template will render here…</span>}</div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Sample uses &quot;{SAMPLE_NAME}&quot; and your top {count} proof points. The real send is tailored to each person.</p>
        </div>
      </div>
    </main>
  );
}

// ---- API hub ----
function ApiHubPanel() {
  const [s, setS] = useState<any>(null);
  const [saved, setSaved] = useState('');
  const load = useCallback(async () => setS(await api('/api/settings')), []);
  useEffect(() => { load(); }, [load]);

  const field = (k: string) => ({ value: s?.[k] ?? '', onChange: (e: any) => setS({ ...s, [k]: e.target.value }) });
  const save = async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(s) });
    setS({ ...s, anthropicKey: '', openaiKey: '', hunterKey: '', tombaKey: '', tombaSecret: '' });
    setSaved('Saved ✓'); setTimeout(() => setSaved(''), 2000);
    load();
  };

  if (!s) return <main className="view"><p className="muted">Loading…</p></main>;

  return (
    <main className="view">
        <div className="settings-form">
          <>
              <h2>AI model</h2>
              <label>Provider
                <select {...field('provider')}>
                  <option value="anthropic">Anthropic (Claude) — recommended</option>
                  <option value="openai">OpenAI-compatible (Ollama, Groq, Together…)</option>
                </select>
              </label>
              {s.provider === 'anthropic' ? (
                <>
                  <label>Model
                    <select {...field('model')}>
                      <option value="claude-opus-4-8">Claude Opus 4.8 — best judgment ($5/$25 per MTok)</option>
                      <option value="claude-sonnet-5">Claude Sonnet 5 — balanced ($3/$15 per MTok)</option>
                      <option value="claude-haiku-4-5">Claude Haiku 4.5 — cheapest for bulk ($1/$5 per MTok)</option>
                    </select>
                  </label>
                  <label>Anthropic API key <span className="muted">{s.hasAnthropicKey ? '· configured ✓' : '· required to run the AI'}</span>
                    <input type="password" value={s.anthropicKey ?? ''} onChange={(e) => setS({ ...s, anthropicKey: e.target.value })} placeholder="sk-ant-… (leave blank to keep current)" /></label>
                </>
              ) : (
                <>
                  <label>Base URL<input {...field('openaiBaseUrl')} placeholder="http://localhost:11434/v1" /></label>
                  <label>Model name<input {...field('openaiModel')} placeholder="llama-3.3-70b-versatile" /></label>
                  <label>API key <span className="muted">{s.hasOpenaiKey ? '· configured ✓' : ''}</span>
                    <input type="password" value={s.openaiKey ?? ''} onChange={(e) => setS({ ...s, openaiKey: e.target.value })} placeholder="Not needed for local Ollama" /></label>
                </>
              )}

              <h2>Email finders <span className="muted">(optional)</span></h2>
              <p className="muted">Bio + website scanning is built in and free. Add a finder to look up emails by name + company domain — the app tries Hunter first, then Tomba.</p>
              <label>Hunter.io API key <span className="muted">{s.hasHunterKey ? '· configured ✓' : '· free tier: 25/mo'} · <a href="https://hunter.io" target="_blank" rel="noopener noreferrer">get key ↗</a></span>
                <input type="password" value={s.hunterKey ?? ''} onChange={(e) => setS({ ...s, hunterKey: e.target.value })} placeholder="Leave blank to skip" /></label>
              <label>Tomba.io API key <span className="muted">{s.hasTombaKey ? '· configured ✓' : '· free tier: 25/mo'} · <a href="https://tomba.io" target="_blank" rel="noopener noreferrer">get key ↗</a></span>
                <input type="password" value={s.tombaKey ?? ''} onChange={(e) => setS({ ...s, tombaKey: e.target.value })} placeholder="ta_… (key)" /></label>
              <label>Tomba.io secret
                <input type="password" value={s.tombaSecret ?? ''} onChange={(e) => setS({ ...s, tombaSecret: e.target.value })} placeholder="ts_… (secret)" /></label>

              <h2>Gmail</h2>
              <p className="muted">{s.gmailConnected ? 'Connected ✓ — drafts save to your Gmail Drafts folder.' : 'Not connected — sign out and back in, and grant Gmail access.'}</p>
          </>

          <div style={{ marginTop: 20 }}>
            <button className="btn primary" onClick={save}>Save</button> <span className="muted">{saved}</span>
          </div>
        </div>
    </main>
  );
}

// ---- Usage & cost ----
const KIND_LABELS: Record<string, string> = {
  classify: 'Lead analysis', message: 'Personalized messages', dm_draft: 'DM drafts', email_draft: 'Email drafts'
};

function UsagePanel() {
  const [u, setU] = useState<any>(null);
  useEffect(() => { api('/api/usage').then(setU).catch(() => setU(null)); }, []);
  if (!u) return <p className="muted">Loading usage…</p>;

  const money = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  const tok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const maxDay = Math.max(0.0001, ...u.daily.map((d: any) => d.cost));

  return (
    <div>
      <div className="stat-grid">
        <div className="stat-card"><div className="stat-label">Total spent</div><div className="stat-num">{money(u.totalCost)}</div><div className="stat-sub">on AI (Anthropic)</div></div>
        <div className="stat-card"><div className="stat-label">AI calls</div><div className="stat-num">{u.calls.toLocaleString()}</div><div className="stat-sub">analysis + drafts</div></div>
        <div className="stat-card"><div className="stat-label">Tokens</div><div className="stat-num">{tok(u.inputTokens + u.outputTokens)}</div><div className="stat-sub">{tok(u.inputTokens)} in · {tok(u.outputTokens)} out</div></div>
        <div className="stat-card"><div className="stat-label">Email lookups</div><div className="stat-num">{u.emailLookups.toLocaleString()}</div><div className="stat-sub">{u.lookups.map((l: any) => `${l.calls} ${l.provider}`).join(' · ') || 'Hunter / Tomba'}</div></div>
      </div>

      <div className="usage-panel">
        <h3>Cost — last 30 days</h3>
        {u.daily.length === 0 ? <p className="muted">No usage yet. Run a find on the Leads tab and it&apos;ll show up here.</p> : (
          <div className="bars">
            {u.daily.map((d: any, i: number) => (
              <div key={d.day} className="bar-col" title={`${d.day}: ${money(d.cost)} · ${d.calls} calls`}>
                <div className="bar" style={{ height: `${Math.max(2, (d.cost / maxDay) * 100)}%` }} />
                <div className="bar-label">{i % 5 === 0 || i === u.daily.length - 1 ? d.day.slice(5) : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="usage-panel">
        <h3>By action</h3>
        <table className="usage-table">
          <thead><tr><th>Action</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>
            {u.byKind.length === 0 ? <tr><td colSpan={4} className="muted">Nothing yet.</td></tr> :
              [...u.byKind].sort((a: any, b: any) => b.cost - a.cost).map((k: any) => (
                <tr key={k.kind}><td>{KIND_LABELS[k.kind] || k.kind}</td><td>{k.calls.toLocaleString()}</td><td>{tok(k.inTok + k.outTok)}</td><td>{money(k.cost)}</td></tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
