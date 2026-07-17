'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import LeadDrawer, { type Lead } from './LeadDrawer';
import { Icon } from './icons';
import { DEFAULT_DM_TEMPLATE, DEFAULT_EMAIL_TEMPLATE, DEFAULT_PROOF_POINTS } from '@/lib/defaults';

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
interface JobState { status: string; total: number; done: number; found: number; drafted: number; target: number; errors: number; lastError: string | null; }

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
  const [findCount, setFindCount] = useState(200);
  const [banner, setBanner] = useState<{ kind: string; job: JobState } | null>(null);
  const [showImport, setShowImport] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
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
  const poolFor = (n: number) => Math.max(1000, Math.min(20000, n * 10));
  const refreshFindEst = useCallback(async () => {
    try { const e = await api(`/api/classify?minHScore=15&limit=${poolFor(findCount || 200)}`); setFindEst({ count: e.count, cost: e.estimatedCostUSD ?? null, model: e.model }); }
    catch { setFindEst(null); }
  }, [findCount]);
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
          else if (activeKind.current === 'classify') alert(`Find finished — ${j.found} strong matches${j.target ? ` (target: ${j.target})` : ''}. Download them with Export → Top matches.`);
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
      setImporting('Reading file…');
      const text = await file.text();
      // Parse in the browser, then upload in batches. Vercel caps a single
      // request body at ~4.5 MB, so a big followers list must be chunked.
      const { parse } = await import('csv-parse/browser/esm/sync');
      let records: Record<string, string>[];
      try {
        records = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
      } catch (err) {
        throw new Error(`CSV parse failed: ${(err as Error).message}`);
      }
      if (!records.length) throw new Error('No rows found in CSV.');

      const BATCH = 2000;
      let imported = 0, skipped = 0;
      for (let i = 0; i < records.length; i += BATCH) {
        setImporting(`Uploading ${Math.min(i + BATCH, records.length).toLocaleString()} of ${records.length.toLocaleString()}…`);
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: records.slice(i, i + BATCH) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        imported += data.imported; skipped += data.skipped;
      }
      setImporting(null);
      alert(`Imported ${imported.toLocaleString()} leads (${skipped.toLocaleString()} duplicates/blank skipped).`);
      await loadStats(); await loadLeads();
    } catch (err) { setImporting(null); alert((err as Error).message); }
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
      await api('/api/classify', { method: 'POST', body: JSON.stringify({ minHScore: 15, count: findCount || 0, limit: 1500 }) });
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
            <ExportMenu count={findCount || 200} />
          </div>
        </div>

      {banner && (
        <div className="job-banner">
          <span>
            {banner.kind === 'classify' ? `Analyzing: ${banner.job.done}/${banner.job.total} · ${banner.job.found} matches found${banner.job.target ? ` of ${banner.job.target} wanted` : ''}`
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
            <ImportZone onFile={importFile} onClose={() => setShowImport(false)} hasLeads={Boolean(stats?.total)} busy={importing} />
          )}
          <section className="hero">
            <h2>Who are you looking for?</h2>
            <p className="sub">Describe your ideal lead in plain English. The AI reads every profile — and each company&apos;s website — then ranks the best matches with evidence. Reach out by email or X DM in a couple of clicks.</p>
            <textarea value={target} onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. Category-leading AI, dev-tools, or fintech startups that would be a great sponsor for MTS" />
            <div className="hero-row">
              <button className="btn primary" onClick={runFind} disabled={!stats?.total || !target.trim()}><Icon name="sparkle" size={15} /> Find best leads</button>
              <label className="count-ctl" title="The AI stops as soon as it has found this many strong matches — you only pay for what it scans.">
                stop after <input type="number" min={10} max={5000} step={10} value={findCount || ''}
                  onChange={(e) => setFindCount(Math.max(0, Math.min(5000, Math.floor(Number(e.target.value)) || 0)))} /> matches
              </label>
              {!stats?.total ? <span className="est">↑ Import a list first</span>
                : findEst && findEst.count > 0 ? <span className="est">{findCount
                    ? `Scans up to ${findEst.count.toLocaleString()} profiles (best signals first), stops at ${findCount} matches${findEst.cost != null ? ` · max ~$${findEst.cost}` : ''}`
                    : `Analyzes ${findEst.count.toLocaleString()} profiles${findEst.cost != null ? ` · est. ~$${findEst.cost}` : ''} · reads their websites`}</span>
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

// ---- Export menu: download the results as a spreadsheet (CSV) ----
function ExportMenu({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="export-menu">
      <button className="btn ghost small" onClick={() => setOpen((o) => !o)}><Icon name="download" size={14} /> Export ▾</button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="menu">
            <a href={`/api/export?best=${count}`} download onClick={close}>Top {count} matches</a>
            <a href={`/api/export?best=${count}&fit=sponsor`} download onClick={close}>Top {count} sponsors</a>
            <a href={`/api/export?best=${count}&fit=guest`} download onClick={close}>Top {count} guests</a>
            <a href="/api/export" download onClick={close}>All leads</a>
            <div className="menu-note">CSV spreadsheet — opens in Excel &amp; Google Sheets</div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Import zone ----
function ImportZone({ onFile, onClose, hasLeads, busy }: { onFile: (f: File) => void; onClose: () => void; hasLeads: boolean; busy: string | null }) {
  const [drag, setDrag] = useState(false);
  return (
    <section className={`import-zone ${drag ? 'dragover' : ''}`}
      onDragOver={(e) => { if (busy) return; e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (busy) return; if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
      <div>
        <strong>Import your followers list</strong>
        <p>Drop a CSV export here (Circleboom, Followerwonk, twtData, or any CSV with a username column). Duplicates are skipped.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {busy ? (
          <span className="import-busy">{busy}</span>
        ) : (
          <label className="btn primary">Choose CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); }} /></label>
        )}
        {hasLeads && !busy ? <button className="btn ghost" onClick={onClose}>Close</button> : null}
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

// ---- Template editor (DM / Email): guided steps + live preview ----
const SAMPLE_NAME = 'Sarah';
const TOKENS: { token: string; label: string; desc: string }[] = [
  { token: '[name]', label: '[name]', desc: 'their first name' },
  { token: '[proof points]', label: '[proof points]', desc: 'your best traction bullets' }
];

export function TemplatePanel({ channel }: { channel: 'dm' | 'email' }) {
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

  const resetDefault = () => {
    if (!confirm('Replace your template with the default MTS one?')) return;
    setTpl(channel === 'dm' ? DEFAULT_DM_TEMPLATE : DEFAULT_EMAIL_TEMPLATE);
    if (!points.filter((p) => p.trim()).length) setPoints(DEFAULT_PROOF_POINTS);
  };

  // Render the preview with tokens substituted AND highlighted, so it's obvious
  // which parts get personalized per recipient.
  const previewNodes = () => {
    const parts = tpl.split(/(\[name\]|\[proof points\])/gi);
    if (!tpl.trim()) return <span className="muted">Your message will render here as you type…</span>;
    return parts.map((p, i) => {
      if (/^\[name\]$/i.test(p)) return <mark key={i} className="tok">{SAMPLE_NAME}</mark>;
      if (/^\[proof points\]$/i.test(p)) {
        const used = points.filter((x) => x.trim()).slice(0, count);
        return <mark key={i} className="tok">{used.length ? used.map((pt) => '• ' + pt).join('\n') : '• (add proof points in step 2)'}</mark>;
      }
      return p;
    });
  };
  const missing = TOKENS.filter((t) => !tpl.toLowerCase().includes(t.token));

  if (!loaded) return <main className="view"><p className="muted">Loading…</p></main>;

  return (
    <main className="view">
      <div className="tpl-layout">
        <div className="tpl-editor">
          <div className="tpl-card">
            <div className="step-head"><span className="step-num">1</span><h3>Write your message</h3></div>
            <p className="muted" style={{ margin: '0 0 12px' }}>{channel === 'dm'
              ? 'Short and casual — it’s an X DM. The AI personalizes it per person.'
              : 'Your cold email. The AI personalizes it per person and writes a unique subject line for each.'}</p>
            <div className="tok-palette">
              {TOKENS.map((t) => (
                <button key={t.token} className="tok-chip" onClick={() => insert(t.token)} title="Insert at cursor">
                  <b>+ {t.label}</b><span>{t.desc}</span>
                </button>
              ))}
            </div>
            <textarea ref={taRef} rows={channel === 'dm' ? 9 : 13} value={tpl} onChange={(e) => setTpl(e.target.value)}
              placeholder="Write your message. Click the chips above to drop in the personalized parts." />
            {missing.length > 0 && tpl.trim() ? (
              <p className="tok-hint">Tip: add {missing.map((m) => <code key={m.token}>{m.token}</code>).reduce((a: any[], c, i) => i ? [...a, ' and ', c] : [c], [])} so each message gets personalized.</p>
            ) : null}
            {channel === 'email' && (
              <label className="tpl-sig">Signs off as
                <input value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="e.g. Gavin O'Keeffe" />
              </label>
            )}
          </div>

          <div className="tpl-card">
            <div className="step-head"><span className="step-num">2</span><h3>Your proof points</h3>
              <span className="muted" style={{ marginLeft: 'auto' }}>AI picks the best {count} for each person</span></div>
            <div className="pp-list">
              {points.map((p, i) => (
                <div className="pp-row" key={i}>
                  <span className="pp-num">{i + 1}</span>
                  <input value={p} onChange={(e) => { const c = [...points]; c[i] = e.target.value; setPoints(c); }} placeholder="A traction proof point — numbers work best" />
                  <button className="pp-del" onClick={() => setPoints(points.filter((_, j) => j !== i))} title="Remove">✕</button>
                </div>
              ))}
            </div>
            <div className="pp-foot">
              <button className="chip-btn" onClick={() => setPoints([...points, ''])}>+ Add proof point</button>
              <label className="pp-count">Use
                <input type="number" min={1} max={8} value={count} onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 4)))} />
                per message</label>
            </div>
          </div>

          <div className="tpl-save">
            <button className="btn primary" onClick={save}><Icon name="check" size={14} /> Save template</button>
            <span className="save-ok">{saved}</span>
            <span className="spacer" />
            <button className="btn ghost small" onClick={resetDefault}>Reset to default</button>
          </div>
        </div>

        <div className="tpl-preview">
          <div className="step-head"><span className="step-num">3</span><h3>Live preview</h3></div>
          {channel === 'email' ? (
            <div className="preview-card email">
              <div className="preview-meta"><span className="muted">To</span> sarah@acme.com</div>
              <div className="preview-meta"><span className="muted">Subject</span> <em className="muted">AI writes one per recipient</em></div>
              <div className="preview-body">{previewNodes()}</div>
            </div>
          ) : (
            <div className="dm-thread">
              <div className="dm-bubble"><div className="preview-body">{previewNodes()}</div></div>
              <div className="dm-meta">Sent from your X account</div>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}><mark className="tok" style={{ padding: '0 4px' }}>Highlighted</mark> parts are personalized per recipient — this sample uses &quot;{SAMPLE_NAME}&quot; and your top {count} proof points.</p>
        </div>
      </div>
    </main>
  );
}

// ---- API hub: one card per service ----
function StatusPill({ state, label }: { state: 'ok' | 'warn' | 'off'; label: string }) {
  return <span className={`pill ${state}`}>{label}</span>;
}

export function ApiHubPanel() {
  const [s, setS] = useState<any>(null);
  const [savedCard, setSavedCard] = useState('');
  const load = useCallback(async () => setS(await api('/api/settings')), []);
  useEffect(() => { load(); }, [load]);

  const field = (k: string) => ({ value: s?.[k] ?? '', onChange: (e: any) => setS({ ...s, [k]: e.target.value }) });
  const saveCard = async (card: string, keys: string[]) => {
    const body: Record<string, unknown> = {};
    for (const k of keys) body[k] = s[k];
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    setS((cur: any) => ({ ...cur, anthropicKey: '', openaiKey: '', hunterKey: '', tombaKey: '', tombaSecret: '' }));
    setSavedCard(card); setTimeout(() => setSavedCard(''), 2000);
    load();
  };
  const saveBtn = (card: string, keys: string[]) => (
    <div className="api-foot">
      <button className="btn primary small" onClick={() => saveCard(card, keys)}>Save</button>
      <span className="save-ok">{savedCard === card ? 'Saved ✓' : ''}</span>
    </div>
  );

  if (!s) return <main className="view"><p className="muted">Loading…</p></main>;

  const aiReady = s.provider === 'anthropic' ? s.hasAnthropicKey : Boolean(s.openaiBaseUrl && s.openaiModel);

  return (
    <main className="view">
      <p className="muted" style={{ margin: '0 0 14px' }}>Each service the app talks to, in one place. Only the AI model is required — everything else is optional.</p>
      <div className="api-grid">

        <section className="api-card">
          <div className="api-card-head">
            <span className="api-ic"><Icon name="sparkle" size={17} /></span>
            <div><h3>AI model</h3><span className="api-tag">Required · powers lead analysis &amp; drafts</span></div>
            <StatusPill state={aiReady ? 'ok' : 'warn'} label={aiReady ? 'Connected' : 'Key needed'} />
          </div>
          <p className="api-desc">Reads every profile and website, ranks your best matches, and writes your personalized DMs and emails.</p>
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
              <label>API key <span className="muted">{s.hasAnthropicKey ? '· saved ✓ (leave blank to keep)' : <>· <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">get one ↗</a></>}</span>
                <input type="password" value={s.anthropicKey ?? ''} onChange={(e) => setS({ ...s, anthropicKey: e.target.value })} placeholder="sk-ant-…" /></label>
            </>
          ) : (
            <>
              <label>Base URL<input {...field('openaiBaseUrl')} placeholder="http://localhost:11434/v1" /></label>
              <label>Model name<input {...field('openaiModel')} placeholder="llama-3.3-70b-versatile" /></label>
              <label>API key <span className="muted">{s.hasOpenaiKey ? '· saved ✓' : '· not needed for local Ollama'}</span>
                <input type="password" value={s.openaiKey ?? ''} onChange={(e) => setS({ ...s, openaiKey: e.target.value })} placeholder="sk-…" /></label>
            </>
          )}
          {saveBtn('ai', ['provider', 'model', 'openaiBaseUrl', 'openaiModel', 'anthropicKey', 'openaiKey'])}
        </section>

        <section className="api-card">
          <div className="api-card-head">
            <span className="api-ic"><Icon name="draft" size={17} /></span>
            <div><h3>Gmail</h3><span className="api-tag">Drafts, ready to send</span></div>
            <StatusPill state={s.gmailConnected ? 'ok' : 'warn'} label={s.gmailConnected ? 'Connected' : 'Not connected'} />
          </div>
          <p className="api-desc">Saves each AI-written email straight into your Gmail Drafts folder — you review and hit send from Gmail.</p>
          <p className="api-desc">{s.gmailConnected
            ? 'Connected via your Google login. Nothing to configure.'
            : 'Sign out, sign back in with Google, and allow the “compose drafts” permission when asked.'}</p>
        </section>

        <section className="api-card">
          <div className="api-card-head">
            <span className="api-ic"><Icon name="search" size={17} /></span>
            <div><h3>Hunter.io</h3><span className="api-tag">Email finder · optional</span></div>
            <StatusPill state={s.hasHunterKey ? 'ok' : 'off'} label={s.hasHunterKey ? 'Connected' : 'Optional'} />
          </div>
          <p className="api-desc">Looks up work emails by name + company domain when the free bio &amp; website scan comes up empty. Tried first. Free tier: 25 lookups/mo.</p>
          <label>API key <span className="muted">{s.hasHunterKey ? '· saved ✓ (leave blank to keep)' : <>· <a href="https://hunter.io/api-keys" target="_blank" rel="noopener noreferrer">get key ↗</a></>}</span>
            <input type="password" value={s.hunterKey ?? ''} onChange={(e) => setS({ ...s, hunterKey: e.target.value })} placeholder="Leave blank to skip" /></label>
          {saveBtn('hunter', ['hunterKey'])}
        </section>

        <section className="api-card">
          <div className="api-card-head">
            <span className="api-ic"><Icon name="email" size={17} /></span>
            <div><h3>Tomba.io</h3><span className="api-tag">Email finder · optional</span></div>
            <StatusPill state={s.hasTombaKey ? 'ok' : 'off'} label={s.hasTombaKey ? 'Connected' : 'Optional'} />
          </div>
          <p className="api-desc">Backup email finder — used when Hunter doesn&apos;t find a match. Needs both a key and a secret. Free tier: 25 lookups/mo.</p>
          <label>API key <span className="muted">{s.hasTombaKey ? '· saved ✓' : <>· <a href="https://app.tomba.io/keys/api" target="_blank" rel="noopener noreferrer">get key ↗</a></>}</span>
            <input type="password" value={s.tombaKey ?? ''} onChange={(e) => setS({ ...s, tombaKey: e.target.value })} placeholder="ta_…" /></label>
          <label>Secret
            <input type="password" value={s.tombaSecret ?? ''} onChange={(e) => setS({ ...s, tombaSecret: e.target.value })} placeholder="ts_…" /></label>
          {saveBtn('tomba', ['tombaKey', 'tombaSecret'])}
        </section>

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
