import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { isSetupComplete } from '../db/auth.js';
import { loadConfig } from '../config.js';

const dashboard = new Hono();

// Track server start time for uptime
const startedAt = Date.now();

// ── JSON status endpoint (unauthenticated) ──────────────────────────
dashboard.get('/dashboard/status', async (c) => {
  const db = getDb();
  const config = loadConfig();

  const notesCount = (db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number }).count;
  const sessionsCount = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;

  let search = null;
  if (config.searchEnabled) {
    try {
      const { getSchedulerState } = await import('../search/scheduler.js');
      const schedulerState = getSchedulerState();

      const model = (db.prepare("SELECT value FROM search_config WHERE key = 'embedding_model'").get() as { value: string } | undefined)?.value ?? null;
      const chunkCount = (db.prepare('SELECT COUNT(*) as count FROM search_chunks').get() as { count: number }).count;
      const lastIndexed = (db.prepare('SELECT MAX(indexed_at) as last FROM search_index_state').get() as { last: number | null }).last;

      const running = db.prepare(`
        SELECT notes_total, notes_processed, status
        FROM search_jobs WHERE status = 'running'
        ORDER BY started_at DESC LIMIT 1
      `).get() as { notes_total: number | null; notes_processed: number; status: string } | undefined;

      const lastRun = db.prepare(`
        SELECT status, finished_at, notes_total, notes_processed, error_message
        FROM search_jobs WHERE status IN ('completed', 'failed')
        ORDER BY finished_at DESC LIMIT 1
      `).get() as {
        status: string; finished_at: number | null;
        notes_total: number | null; notes_processed: number; error_message: string | null;
      } | undefined;

      // Count notes needing re-indexing
      const dirtyCount = (db.prepare(`
        SELECT COUNT(*) as count FROM notes n
        LEFT JOIN search_index_state s ON s.uuid = n.uuid AND s.level = 2
        WHERE s.uuid IS NULL OR s.content_hash != n.content_hash
      `).get() as { count: number }).count;

      search = {
        enabled: true,
        enhanced_search_enabled: schedulerState.userEnabled,
        model,
        chunk_count: chunkCount,
        last_indexed_at: lastIndexed,
        current_job: running ? {
          status: running.status,
          notes_total: running.notes_total,
          notes_processed: running.notes_processed,
        } : null,
        last_run: lastRun ? {
          status: lastRun.status,
          finished_at: lastRun.finished_at,
          notes_total: lastRun.notes_total,
          notes_processed: lastRun.notes_processed,
          error_message: lastRun.error_message,
        } : null,
        dirty_count: dirtyCount,
        scheduler: schedulerState,
      };
    } catch {
      search = { enabled: true, error: 'Search tables not initialized' };
    }
  } else {
    search = { enabled: false };
  }

  let transformsStatus = null;
  if (config.transformsEnabled) {
    try {
      const { getTransformsStatus } = await import('../transforms/scheduler.js');
      transformsStatus = getTransformsStatus();
    } catch {
      transformsStatus = { error: 'Transform tables not initialized' };
    }
  }

  return c.json({
    notes_count: notesCount,
    sessions_count: sessionsCount,
    setup_complete: isSetupComplete(db),
    search,
    transforms: transformsStatus,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// ── Dashboard HTML (unauthenticated) ────────────────────────────────
dashboard.get('/', (c) => {
  return c.html(dashboardHtml());
});

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stonefruit — Server Dashboard</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --primary: #B07D3B;
    --primary-hover: #9A6C2F;
    --text: #1C1917;
    --text-secondary: #78716C;
    --border: #DDD8D0;
    --surface: #F0ECE6;
    --bg: #FAF9F6;
    --danger: #B8442A;
    --success: #3D7A3F;
    --radius: 12px;
  }

  body {
    font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
    padding: 2rem 1rem;
  }

  .container {
    max-width: 720px;
    margin: 0 auto;
  }

  header {
    text-align: center;
    margin-bottom: 2.5rem;
  }

  header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  header h1 span {
    color: var(--primary);
  }

  header p {
    color: var(--text-secondary);
    margin-top: 0.25rem;
    font-size: 0.9rem;
  }

  .card {
    background: white;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1rem;
  }

  .card h2 {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    margin-bottom: 0.75rem;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0;
  }

  .stat-row + .stat-row {
    border-top: 1px solid var(--surface);
  }

  .stat-label {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .stat-value {
    font-weight: 500;
    font-size: 0.875rem;
  }

  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .badge-ok { background: #E8F5E9; color: var(--success); }
  .badge-warn { background: #FFF3E0; color: #E65100; }
  .badge-error { background: #FFEBEE; color: var(--danger); }
  .badge-muted { background: var(--surface); color: var(--text-secondary); }

  .progress-track {
    width: 100%;
    height: 6px;
    background: var(--surface);
    border-radius: 3px;
    margin-top: 0.5rem;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--primary);
    border-radius: 3px;
    transition: width 0.4s ease;
  }

  .download-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .download-link {
    display: block;
    text-align: center;
    padding: 0.6rem 1rem;
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    border-radius: 8px;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.15s;
  }

  .download-link:hover {
    background: var(--border);
  }

  .setup-steps {
    list-style: none;
    counter-reset: step;
  }

  .setup-steps li {
    counter-increment: step;
    padding: 0.4rem 0;
    padding-left: 2rem;
    position: relative;
    font-size: 0.875rem;
    color: var(--text);
  }

  .setup-steps li + li {
    border-top: 1px solid var(--surface);
  }

  .setup-steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    width: 1.4rem;
    height: 1.4rem;
    background: var(--primary);
    color: white;
    border-radius: 50%;
    font-size: 0.75rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    top: 0.45rem;
  }

  .setup-steps code {
    background: var(--surface);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .footer {
    text-align: center;
    margin-top: 2rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .footer a {
    color: var(--primary);
    text-decoration: none;
  }

  .footer a:hover {
    text-decoration: underline;
  }

  #error-banner {
    display: none;
    background: #FFEBEE;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: var(--danger);
    font-size: 0.875rem;
  }

  .loading { color: var(--text-secondary); }

  .btn {
    display: inline-block;
    padding: 0.4rem 1rem;
    border-radius: 8px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: inherit;
    border: none;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .btn-primary {
    background: var(--primary);
    color: white;
  }

  .btn-primary:hover { background: var(--primary-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-muted {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-muted:hover { background: var(--border); }
  .btn-muted:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-link {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: var(--primary);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .action-link:hover {
    color: var(--primary-hover);
  }
  .action-link:disabled {
    color: var(--text-secondary);
    text-decoration: none;
    cursor: not-allowed;
    opacity: 0.7;
  }
  .btn-danger {
    background: linear-gradient(180deg, #B61D12 0%, #7D120C 100%);
    color: white;
    border: 1px solid #5F0D08;
    box-shadow: 0 6px 16px rgba(125, 18, 12, 0.35);
  }
  .btn-danger:hover {
    background: linear-gradient(180deg, #C62518 0%, #8A150D 100%);
  }
  .btn-danger:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    box-shadow: none;
  }

  .danger-card {
    border: 1px solid #D26A5E;
    background: linear-gradient(180deg, #FFF6F4 0%, #FFEDEA 100%);
  }

  .danger-card h2 {
    color: #8A150D;
  }

  .danger-copy {
    font-size: 0.9rem;
    color: #6A1610;
    margin-bottom: 0.25rem;
    font-weight: 600;
  }

  .danger-callout {
    font-size: 0.85rem;
    color: #8A150D;
  }

  .danger-list {
    margin: 0.65rem 0 1rem 1.1rem;
    color: #6A1610;
    font-size: 0.85rem;
  }

  .danger-list li + li {
    margin-top: 0.3rem;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(29, 25, 23, 0.72);
    z-index: 1000;
  }

  .modal-backdrop.open {
    display: flex;
  }

  .danger-modal {
    width: min(540px, 100%);
    border: 2px solid #B61D12;
    border-radius: 14px;
    background: #FFF5F2;
    padding: 1rem 1.1rem;
    box-shadow: 0 14px 36px rgba(28, 25, 23, 0.45);
  }

  .danger-modal h3 {
    color: #8A150D;
    font-size: 1.05rem;
    margin-bottom: 0.5rem;
  }

  .danger-modal p {
    font-size: 0.875rem;
    color: #5B1812;
  }

  .danger-modal ul {
    margin: 0.65rem 0 0.75rem 1.2rem;
    font-size: 0.84rem;
    color: #5B1812;
  }

  .danger-modal ul li + li {
    margin-top: 0.25rem;
  }

  .danger-modal label {
    display: block;
    font-size: 0.8rem;
    color: #7D120C;
    font-weight: 600;
    margin-bottom: 0.35rem;
  }

  .danger-input {
    width: 100%;
    border: 1px solid #D26A5E;
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    font-family: inherit;
    font-size: 0.9rem;
    color: #1C1917;
    background: white;
  }

  .danger-input:focus {
    outline: none;
    border-color: #B61D12;
    box-shadow: 0 0 0 2px rgba(182, 29, 18, 0.18);
  }

  .danger-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }

  .danger-final {
    margin-top: 0.65rem;
    font-size: 0.8rem;
    color: #7D120C;
    font-weight: 600;
  }

  .index-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--surface);
  }

  .index-status {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .phase-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .search-dimmed {
    opacity: 0.55;
    pointer-events: none;
  }


  @media (max-width: 480px) {
    body { padding: 1rem 0.75rem; }
    .download-grid { grid-template-columns: 1fr; }
    .danger-actions { flex-direction: column-reverse; }
    .danger-actions .btn { width: 100%; }
  }
</style>
</head>
<body>

<div class="container">
  <header>
    <h1>FUTO <span>Notes</span></h1>
    <p>Server Dashboard</p>
  </header>

  <div id="error-banner"></div>

  <!-- Status -->
  <div class="card">
    <h2>Server</h2>
    <div class="stat-row">
      <span class="stat-label">Status</span>
      <span class="stat-value" id="status"><span class="loading">...</span></span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Setup</span>
      <span class="stat-value" id="setup"><span class="loading">...</span></span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Notes</span>
      <span class="stat-value" id="notes-count"><span class="loading">...</span></span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Connected devices</span>
      <span class="stat-value" id="sessions-count"><span class="loading">...</span></span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Uptime</span>
      <span class="stat-value" id="uptime"><span class="loading">...</span></span>
    </div>
  </div>

  <!-- Search / Indexing -->
  <div class="card" id="search-card">
    <h2>Search &amp; Indexing</h2>
    <div id="search-content"><span class="loading">Loading...</span></div>
  </div>

  <!-- Smart Transforms -->
  <div class="card" id="transforms-card" style="display:none">
    <h2>Smart Transforms</h2>
    <div id="transforms-content"><span class="loading">Loading...</span></div>
  </div>

  <!-- Download -->
  <div class="card">
    <h2>Download Apps</h2>
    <div class="download-grid">
      <a class="download-link" href="https://play.google.com/store/apps/details?id=org.futo.notes" target="_blank">Android</a>
      <a class="download-link" href="https://apps.apple.com/app/futo-notes/id0000000000" target="_blank">iOS</a>
      <a class="download-link" href="https://github.com/nickoehler/futo-notes-releases/releases" target="_blank">Desktop</a>
      <a class="download-link" href="https://notes.futo.org" target="_blank">Web</a>
    </div>
  </div>

  <!-- Setup Guide -->
  <div class="card">
    <h2>Setup Guide</h2>
    <ol class="setup-steps">
      <li>Download Stonefruit on your device using a link above</li>
      <li>Open the app, go to <strong>Settings → Sync</strong>, and enter this server's URL: <code id="server-url">...</code></li>
      <li>Enter the password you set during server setup and tap <strong>Connect</strong></li>
    </ol>
  </div>

  <!-- Danger Zone -->
  <div class="card danger-card">
    <h2>Danger Zone</h2>
    <p class="danger-copy">Erase and Reset is permanent.</p>
    <p class="danger-callout">This will return the server to a fresh-install state.</p>
    <ul class="danger-list">
      <li>Delete every note from disk and from the notes database</li>
      <li>Clear setup, including the current server password</li>
      <li>Immediately log out all connected devices and sessions</li>
    </ul>
    <button class="btn btn-danger" id="erase-reset-btn" onclick="openResetDialog()">Erase and Reset</button>
  </div>

  <div class="footer">
    <a href="https://notes.futo.org">Stonefruit</a> · <a href="https://futo.org">FUTO</a>
  </div>
</div>

<div id="reset-modal" class="modal-backdrop" aria-hidden="true">
  <div class="danger-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
    <h3 id="reset-title">Erase and Reset Server</h3>
    <p>This action cannot be undone. If you continue, this server will be reset to a fresh install:</p>
    <ul>
      <li>All notes are permanently erased from disk and database</li>
      <li>Setup is removed, so you must run setup again</li>
      <li>Every logged-in device is revoked right away</li>
    </ul>
    <label for="reset-confirm-input">Type DELETE (all caps) to enable the final delete button</label>
    <input id="reset-confirm-input" class="danger-input" type="text" autocomplete="off" spellcheck="false" placeholder="DELETE">
    <div class="danger-actions">
      <button class="btn btn-muted" id="reset-cancel-btn" onclick="closeResetDialog()">Cancel</button>
      <button class="btn btn-danger" id="reset-confirm-btn" onclick="eraseAndReset()" disabled>Delete everything</button>
    </div>
    <p class="danger-final">Your current dashboard login will also be invalidated immediately.</p>
  </div>
</div>

<script>
(function() {
  const $ = (id) => document.getElementById(id);

  // Show the current URL as the server URL
  $('server-url').textContent = location.origin;

  function formatUptime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h + 'h ' + m + 'm';
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return d + 'd ' + h + 'h';
  }

  function formatTime(unix) {
    if (!unix) return 'Never';
    const d = new Date(unix * 1000);
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString();
  }

  function badge(text, type) {
    return '<span class="badge badge-' + type + '">' + text + '</span>';
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  const phaseLabels = {
    idle: null,
    downloading_model: 'Downloading embedding model files...',
    loading_model: 'Preparing embedding model in memory (first query after restart can do this)...',
    indexing: 'Indexing notes...',
    building_artifacts: 'Building search artifacts...',
    disabled: null,
  };

  function renderSearch(s) {
    if (!s || !s.enabled) {
      return '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Disabled', 'muted') + '</div>';
    }
    if (s.error) {
      return '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Error', 'error') + '</div>' +
        '<div class="stat-row"><span class="stat-label">Details</span><span class="stat-value">' + s.error + '</span></div>';
    }

    let html = '';
    const sched = s.scheduler || {};
    const phaseText = phaseLabels[sched.phase];
    const isBusy = sched.phase && sched.phase !== 'idle' && sched.phase !== 'disabled';
    const hasIndexedBefore = Boolean(s.last_indexed_at);
    const enhancedSearchEnabled = s.enhanced_search_enabled !== false;
    const disabledReason = sched.disabledReason || null;
    const userDisabled = !enhancedSearchEnabled && disabledReason === 'user';
    const preIndexSummary = !hasIndexedBefore && !isBusy && !s.current_job;

    if (userDisabled) {
      html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Disabled', 'muted') + '</div>';
      html += '<div class="stat-row"><span class="stat-label">Reason</span><span class="stat-value">Enhanced search is turned off</span></div>';
      if (hasIndexedBefore) {
        html += '<div class="search-dimmed">';
        html += '<div class="stat-row"><span class="stat-label">Chunks indexed</span><span class="stat-value">' + (s.chunk_count || 0).toLocaleString() + '</span></div>';
        html += '<div class="stat-row"><span class="stat-label">Last indexed</span><span class="stat-value">' + formatTime(s.last_indexed_at) + '</span></div>';
        html += '</div>';
      }
    } else {
      // Progressive disclosure before first successful index.
      if (preIndexSummary) {
        if (s.dirty_count > 0) {
          html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Pending', 'warn') + '</div>';
          html += '<div class="stat-row"><span class="stat-label">Queued</span><span class="stat-value">' + s.dirty_count + ' notes</span></div>';
        } else {
          html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Ready', 'ok') + '</div>';
        }
        html += '<div class="stat-row"><span class="stat-label">First index</span><span class="stat-value">Will start during next idle window</span></div>';
      } else if (s.current_job) {
        const pct = s.current_job.notes_total
          ? Math.round((s.current_job.notes_processed / s.current_job.notes_total) * 100)
          : 0;
        html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Indexing', 'warn') + '</div>';
        html += '<div class="stat-row"><span class="stat-label">Progress</span><span class="stat-value">' +
          s.current_job.notes_processed + ' / ' + (s.current_job.notes_total || '?') + ' notes</span></div>';
        html += '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
      } else if (isBusy) {
        let statusLabel = 'Working';
        if (sched.phase === 'downloading_model') statusLabel = 'Downloading model';
        if (sched.phase === 'loading_model') statusLabel = 'Preparing model';
        if (sched.phase === 'building_artifacts') statusLabel = 'Building artifacts';
        html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge(statusLabel, 'warn') + '</div>';
        if (phaseText) {
          html += '<div class="stat-row"><span class="stat-label">Phase</span><span class="phase-label">' + phaseText + '</span></div>';
        }
        // Show download progress bar
        if (sched.phase === 'downloading_model' && sched.downloadProgress) {
          const dp = sched.downloadProgress;
          const dlPct = dp.totalSize > 0 ? Math.round((dp.downloadedSize / dp.totalSize) * 100) : 0;
          html += '<div class="stat-row"><span class="stat-label">Download</span><span class="stat-value">' +
            formatBytes(dp.downloadedSize) + ' / ' + formatBytes(dp.totalSize) + ' (' + dlPct + '%)</span></div>';
          html += '<div class="progress-track"><div class="progress-fill" style="width:' + dlPct + '%"></div></div>';
        }
      } else if (sched.phase === 'disabled') {
        html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Disabled', 'error') + '</div>';
        const reasonText = 'Enhanced search is turned off';
        html += '<div class="stat-row"><span class="stat-label">Reason</span><span class="stat-value">' + reasonText + '</span></div>';
      } else if (s.dirty_count > 0) {
        html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Pending', 'warn') + '</div>';
        html += '<div class="stat-row"><span class="stat-label">Queued</span><span class="stat-value">' + s.dirty_count + ' notes</span></div>';
        // Explain why it's waiting
        if (sched.idleWindow && !sched.idleWindow.active) {
          html += '<div class="stat-row"><span class="stat-label">Waiting for</span><span class="stat-value">Idle window (' + sched.idleWindow.start + ' – ' + sched.idleWindow.end + ')</span></div>';
        }
      } else {
        html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Up to date', 'ok') + '</div>';
      }

      // Model display (fixed to qwen3-embedding-0.6b)
      if (!preIndexSummary) {
        const modelText = s.model || 'qwen3-embedding-0.6b';
        html += '<div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">' + modelText + '</span></div>';
      }

      if (!preIndexSummary) {
        // Chunks indexed
        html += '<div class="stat-row"><span class="stat-label">Chunks indexed</span><span class="stat-value">' + (s.chunk_count || 0).toLocaleString() + '</span></div>';

        // Last indexed
        html += '<div class="stat-row"><span class="stat-label">Last indexed</span><span class="stat-value">' + formatTime(s.last_indexed_at) + '</span></div>';

        // Last run error
        if (s.last_run && s.last_run.status === 'failed' && s.last_run.error_message) {
          html += '<div class="stat-row"><span class="stat-label">Last error</span><span class="stat-value" style="color:var(--danger)">' + s.last_run.error_message + '</span></div>';
        }
      }
    }

    // Actions
    html += '<div class="index-row">';
    html += '<button class="btn btn-primary" id="index-now-btn" onclick="indexNow()"' + (isBusy || userDisabled ? ' disabled' : '') + '>Index now</button>';
    html += '<button class="action-link" id="enhanced-search-toggle" onclick="setEnhancedSearchEnabled(' + (enhancedSearchEnabled ? 'false' : 'true') + ')"' + (isBusy ? ' disabled' : '') + '>' + (enhancedSearchEnabled ? 'Disable enhanced search' : 'Enable enhanced search') + '</button>';
    html += '<span class="index-status" id="index-status"></span>';
    html += '</div>';

    return html;
  }

  function renderTransforms(t) {
    if (!t || t.error) return '';
    var html = '';
    var sched = t.scheduler || {};
    var isBusy = sched.running;

    for (var i = 0; i < t.transforms.length; i++) {
      var tr = t.transforms[i];
      if (i > 0) html += '<div style="border-top:1px solid var(--surface);margin:0.5rem 0"></div>';
      html += '<div class="stat-row"><span class="stat-label" style="font-weight:600">' + tr.name + '</span>';
      html += '<span class="stat-value">' + (tr.enabled ? badge('Enabled', 'ok') : badge('Disabled', 'muted')) + '</span></div>';
      html += '<div class="stat-row"><span class="stat-label" style="font-size:0.8rem;color:var(--text-secondary)">' + tr.description + '</span></div>';
      if (tr.enabled) {
        html += '<div class="stat-row"><span class="stat-label">Pending</span><span class="stat-value">' + tr.pending_count + ' notes</span></div>';
        if (tr.last_run) {
          html += '<div class="stat-row"><span class="stat-label">Last run</span><span class="stat-value">' +
            badge(tr.last_run.status, tr.last_run.status === 'completed' ? 'ok' : 'error') +
            ' (' + tr.last_run.notes_processed + ' notes)</span></div>';
          if (tr.last_run.status === 'failed' && tr.last_run.error_message) {
            html += '<div class="stat-row"><span class="stat-label">Error</span><span class="stat-value" style="color:var(--danger);font-size:0.8rem">' + tr.last_run.error_message + '</span></div>';
          }
        }
      }
      html += '<div class="index-row">';
      html += '<button class="btn btn-primary" onclick="triggerTransform(\\'' + tr.id + '\\')"' + (isBusy || !tr.enabled ? ' disabled' : '') + '>Run now</button>';
      html += '<button class="action-link" onclick="toggleTransform(\\'' + tr.id + '\\',' + !tr.enabled + ')"' + (isBusy ? ' disabled' : '') + '>' + (tr.enabled ? 'Disable' : 'Enable') + '</button>';
      html += '</div>';
    }

    // Scheduler-level error (e.g. model load failure)
    if (sched.last_error) {
      html += '<div style="border-top:1px solid var(--surface);margin:0.5rem 0"></div>';
      html += '<div class="stat-row"><span class="stat-label">Error</span><span class="stat-value" style="color:var(--danger);font-size:0.8rem">' + sched.last_error + '</span></div>';
    }

    // Model & scheduler status
    if (sched.phase && sched.phase !== 'idle') {
      var phaseLabel = sched.phase === 'downloading_model' ? 'Downloading model...'
        : sched.phase === 'loading_model' ? 'Loading model...'
        : sched.phase === 'running' ? 'Running transforms...'
        : sched.phase;
      html += '<div style="border-top:1px solid var(--surface);margin:0.5rem 0"></div>';
      html += '<div class="stat-row"><span class="stat-label">Status</span><span class="phase-label">' + phaseLabel + '</span></div>';
      if (t.model && t.model.download_progress) {
        var dp = t.model.download_progress;
        var dlPct = dp.totalSize > 0 ? Math.round((dp.downloadedSize / dp.totalSize) * 100) : 0;
        html += '<div class="stat-row"><span class="stat-label">Download</span><span class="stat-value">' +
          formatBytes(dp.downloadedSize) + ' / ' + formatBytes(dp.totalSize) + ' (' + dlPct + '%)</span></div>';
        html += '<div class="progress-track"><div class="progress-fill" style="width:' + dlPct + '%"></div></div>';
      }
    }

    return html;
  }

  let pollTimer = null;
  function schedulePoll(fast) {
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, fast ? 2000 : 5000);
  }

  async function refresh() {
    try {
      const res = await fetch('/dashboard/status');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      $('status').innerHTML = badge('Online', 'ok');
      $('setup').innerHTML = data.setup_complete ? badge('Complete', 'ok') : badge('Not configured', 'warn');
      $('notes-count').textContent = data.notes_count.toLocaleString();
      $('sessions-count').textContent = data.sessions_count;
      $('uptime').textContent = formatUptime(data.uptime_seconds);
      $('search-content').innerHTML = renderSearch(data.search);

      // Render transforms section
      var tCard = $('transforms-card');
      if (tCard) {
        if (data.transforms && !data.transforms.error) {
          tCard.style.display = '';
          $('transforms-content').innerHTML = renderTransforms(data.transforms);
        } else {
          tCard.style.display = 'none';
        }
      }

      $('error-banner').style.display = 'none';

      // Poll faster during active work (download/indexing/transforms)
      const sched = data.search && data.search.scheduler;
      const tSched = data.transforms && data.transforms.scheduler;
      const busy = (sched && sched.phase && sched.phase !== 'idle' && sched.phase !== 'disabled')
        || (tSched && tSched.running);
      schedulePoll(busy);
    } catch (e) {
      $('status').innerHTML = badge('Unreachable', 'error');
      $('error-banner').textContent = 'Could not reach server: ' + e.message;
      $('error-banner').style.display = 'block';
    }
  }

  // Token management
  let authToken = sessionStorage.getItem('dashboard_token');

  function clearAuthToken() {
    authToken = null;
    sessionStorage.removeItem('dashboard_token');
  }

  async function getToken(actionLabel) {
    if (authToken) return authToken;
    const password = prompt('Enter server password to ' + actionLabel + ':');
    if (!password) return null;
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        alert('Invalid password');
        return null;
      }
      const data = await res.json();
      authToken = data.token;
      sessionStorage.setItem('dashboard_token', authToken);
      return authToken;
    } catch (e) {
      alert('Login failed: ' + e.message);
      return null;
    }
  }

  window.indexNow = async function() {
    const btn = $('index-now-btn');
    if (!btn) return;

    const token = await getToken('trigger indexing');
    if (!token) return;

    btn.disabled = true;

    try {
      const res = await fetch('/search/reindex', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        btn.disabled = false;
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to start indexing');
        btn.disabled = false;
        return;
      }
      // 202 Accepted — job is running in background, refresh will show progress
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  };


  window.setEnhancedSearchEnabled = async function(enabled) {
    const token = await getToken(enabled ? 'enable enhanced search' : 'disable enhanced search');
    if (!token) return;

    const btn = $('enhanced-search-toggle');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/search/set-enhanced-search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update enhanced search');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.triggerTransform = async function(id) {
    const token = await getToken('trigger transform');
    if (!token) return;
    try {
      const res = await fetch('/transforms/' + id + '/trigger', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to trigger transform');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.toggleTransform = async function(id, enabled) {
    const token = await getToken(enabled ? 'enable transform' : 'disable transform');
    if (!token) return;
    try {
      const res = await fetch('/transforms/' + id + '/' + (enabled ? 'enable' : 'disable'), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update transform');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  const resetModal = $('reset-modal');
  const resetInput = $('reset-confirm-input');
  const resetConfirmBtn = $('reset-confirm-btn');
  const resetCancelBtn = $('reset-cancel-btn');
  const eraseResetBtn = $('erase-reset-btn');

  function updateResetConfirmState() {
    if (!resetInput || !resetConfirmBtn) return;
    resetConfirmBtn.disabled = resetInput.value !== 'DELETE';
  }

  window.openResetDialog = function() {
    if (!resetModal || !resetInput) return;
    resetModal.classList.add('open');
    resetModal.setAttribute('aria-hidden', 'false');
    resetInput.value = '';
    updateResetConfirmState();
    resetInput.focus();
  };

  window.closeResetDialog = function() {
    if (!resetModal || !resetInput || !resetConfirmBtn || !resetCancelBtn) return;
    resetModal.classList.remove('open');
    resetModal.setAttribute('aria-hidden', 'true');
    resetInput.value = '';
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Delete everything';
    resetCancelBtn.disabled = false;
    if (eraseResetBtn) eraseResetBtn.disabled = false;
  };

  if (resetInput) {
    resetInput.addEventListener('input', updateResetConfirmState);
  }

  if (resetModal) {
    resetModal.addEventListener('click', (event) => {
      if (event.target === resetModal) {
        window.closeResetDialog();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && resetModal && resetModal.classList.contains('open')) {
      window.closeResetDialog();
    }
  });

  window.eraseAndReset = async function() {
    if (!resetInput || !resetConfirmBtn || !resetCancelBtn) return;
    if (resetInput.value !== 'DELETE') {
      alert('Type DELETE in all caps to continue.');
      return;
    }

    const token = await getToken('erase and reset the server');
    if (!token) return;

    resetConfirmBtn.disabled = true;
    resetCancelBtn.disabled = true;
    resetConfirmBtn.textContent = 'Deleting...';
    if (eraseResetBtn) eraseResetBtn.disabled = true;

    try {
      const res = await fetch('/reset', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        window.closeResetDialog();
        return;
      }

      if (!res.ok) {
        alert(data.error || 'Server reset failed');
        resetCancelBtn.disabled = false;
        updateResetConfirmState();
        resetConfirmBtn.textContent = 'Delete everything';
        if (eraseResetBtn) eraseResetBtn.disabled = false;
        return;
      }

      clearAuthToken();
      window.closeResetDialog();
      alert('Server reset complete. All notes were erased, setup was cleared, and every device was logged out.');
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
      resetCancelBtn.disabled = false;
      updateResetConfirmState();
      resetConfirmBtn.textContent = 'Delete everything';
      if (eraseResetBtn) eraseResetBtn.disabled = false;
    }
  };

  refresh();
  schedulePoll(false);
})();
</script>

</body>
</html>`;
}

export default dashboard;
