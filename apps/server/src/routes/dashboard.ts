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

  let pluginsStatus = null;
  if (config.pluginsEnabled) {
    try {
      const { getPluginsStatus } = await import('../plugins/scheduler.js');
      pluginsStatus = await getPluginsStatus();
    } catch {
      pluginsStatus = { error: 'Plugin tables not initialized' };
    }
  }

  return c.json({
    notes_count: notesCount,
    sessions_count: sessionsCount,
    setup_complete: isSetupComplete(db),
    search,
    plugins: pluginsStatus,
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
    max-width: 1080px;
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

  .text-input {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: white;
    color: var(--text);
    font: inherit;
  }

  .text-input:focus {
    outline: 2px solid rgba(176, 125, 59, 0.2);
    outline-offset: 1px;
    border-color: var(--primary);
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

  .plugin-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.2rem 0 0.9rem;
    border-bottom: 1px solid var(--surface);
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }

  .plugin-toolbar-copy {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .plugin-toolbar-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .plugin-toolbar-value {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
  }

  .plugin-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .plugin-auth-note {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .plugin-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
  }

  .plugin-card-grid-empty {
    border: 1px dashed var(--border);
    border-radius: 12px;
    padding: 1rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
    background: linear-gradient(180deg, #FFFEFC 0%, #F6F2EC 100%);
  }

  .plugin-card {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1rem;
    background: linear-gradient(180deg, #FFFEFC 0%, #F6F2EC 100%);
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    min-height: 270px;
  }

  .plugin-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .plugin-card-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .plugin-card-subtitle {
    margin-top: 0.25rem;
    font-size: 0.86rem;
    color: var(--text-secondary);
  }

  .plugin-switch-wrap {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-shrink: 0;
  }

  .plugin-switch {
    appearance: none;
    width: 2.6rem;
    height: 1.5rem;
    border-radius: 999px;
    border: 1px solid rgba(28, 25, 23, 0.12);
    background: #D7D0C7;
    position: relative;
    cursor: pointer;
    transition: background 0.2s ease, opacity 0.2s ease;
  }

  .plugin-switch::before {
    content: '';
    position: absolute;
    top: 1px;
    left: 1px;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 50%;
    background: white;
    box-shadow: 0 1px 3px rgba(28, 25, 23, 0.18);
    transition: transform 0.2s ease;
  }

  .plugin-switch:checked {
    background: var(--success);
  }

  .plugin-switch:checked::before {
    transform: translateX(1.08rem);
  }

  .plugin-switch:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .plugin-switch-state {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .plugin-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .plugin-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.55rem;
    border-radius: 999px;
    background: white;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.76rem;
    font-weight: 600;
  }

  .plugin-card-section {
    border-top: 1px solid rgba(28, 25, 23, 0.08);
    padding-top: 0.75rem;
    display: grid;
    gap: 0.45rem;
  }

  .plugin-card-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    font-size: 0.84rem;
  }

  .plugin-card-row .stat-label {
    font-size: 0.8rem;
  }

  .plugin-card-row .stat-value {
    font-size: 0.82rem;
    text-align: right;
  }

  .plugin-card-row .stat-value.plugin-source {
    max-width: 60%;
    word-break: break-word;
  }

  .plugin-card-note {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .plugin-card-note.plugin-card-warning {
    color: #A04B00;
    font-weight: 600;
  }

  .plugin-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    margin-top: auto;
    padding-top: 0.25rem;
  }

  .plugin-config-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.65rem;
  }

  .plugin-config-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .plugin-config-field label {
    font-size: 0.78rem;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .plugin-config-field input,
  .plugin-config-field select {
    width: 100%;
    padding: 0.45rem 0.55rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: white;
    color: var(--text);
    font: inherit;
  }

  .plugin-config-field input[type="checkbox"] {
    width: auto;
    padding: 0;
  }

  .plugin-run-list {
    display: grid;
    gap: 0.45rem;
  }

  .plugin-run-entry {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.65rem;
    border-radius: 10px;
    border: 1px solid rgba(28, 25, 23, 0.08);
    background: white;
  }

  .plugin-run-entry-copy {
    display: grid;
    gap: 0.15rem;
    font-size: 0.8rem;
  }

  .plugin-run-entry-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .plugin-detail {
    margin-top: 1rem;
    border-top: 1px solid var(--surface);
    padding-top: 1rem;
    display: grid;
    gap: 0.9rem;
  }

  .plugin-detail-section {
    border: 1px solid rgba(28, 25, 23, 0.08);
    border-radius: 12px;
    background: white;
    padding: 0.9rem;
  }

  .plugin-detail-section h3 {
    font-size: 0.92rem;
    margin-bottom: 0.65rem;
  }

  .plugin-run-items {
    display: grid;
    gap: 0.6rem;
  }

  .plugin-run-item {
    border: 1px solid rgba(28, 25, 23, 0.08);
    border-radius: 10px;
    padding: 0.75rem;
    display: grid;
    gap: 0.45rem;
    background: #FFFEFC;
  }

  .plugin-run-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .plugin-log-list {
    display: grid;
    gap: 0.4rem;
    font-size: 0.8rem;
  }

  .plugin-log-entry {
    display: grid;
    gap: 0.2rem;
    padding: 0.5rem 0.6rem;
    border-radius: 8px;
    background: #F8F4EE;
  }


  @media (max-width: 760px) {
    .plugin-grid { grid-template-columns: 1fr; }
    .plugin-config-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 480px) {
    body { padding: 1rem 0.75rem; }
    .download-grid { grid-template-columns: 1fr; }
    .danger-actions { flex-direction: column-reverse; }
    .danger-actions .btn { width: 100%; }
    .plugin-card-header { flex-direction: column; }
    .plugin-switch-wrap { width: 100%; justify-content: space-between; }
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

  <!-- Plugins -->
  <div class="card" id="plugins-card" style="display:none">
    <h2>Automations</h2>
    <div id="plugins-content"><span class="loading">Loading...</span></div>
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
    const timestamp = unix > 1e12 ? unix : unix * 1000;
    const d = new Date(timestamp);
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  let activePluginRunId = null;
  let activePluginRunDetail = null;

  function dayLabel(day) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || 'Day ' + day;
  }

  function scheduleSummary(schedule) {
    if (!schedule || schedule.kind === 'manual') return 'Manual only';
    if (schedule.kind === 'daily') return 'Daily at ' + (schedule.time || '03:00');
    return 'Weekly on ' + dayLabel(schedule.day || 1) + ' at ' + (schedule.time || '03:00');
  }

  function renderPluginConfigField(pluginId, field, value, disabled) {
    var html = '<div class="plugin-config-field">';
    html += '<label>' + escapeHtml(field.label) + '</label>';
    if (field.type === 'boolean') {
      html += '<input type="checkbox" data-plugin-config-field="' + escapeHtml(field.key) + '"' + (value ? ' checked' : '') + (disabled ? ' disabled' : '') + '>';
    } else if (field.type === 'number') {
      html += '<input type="number" data-plugin-config-field="' + escapeHtml(field.key) + '" value="' + escapeHtml(value) + '"' +
        (field.min !== undefined ? ' min="' + field.min + '"' : '') +
        (field.max !== undefined ? ' max="' + field.max + '"' : '') +
        (disabled ? ' disabled' : '') + '>';
    } else {
      html += '<input type="text" data-plugin-config-field="' + escapeHtml(field.key) + '" value="' + escapeHtml(value) + '"' + (disabled ? ' disabled' : '') + '>';
    }
    html += '</div>';
    return html;
  }

  function renderRunDetail(detail, canManagePlugins, isBusy) {
    if (!detail || !detail.run) return '';
    var run = detail.run;
    var html = '<div class="plugin-detail">';
    html += '<div class="plugin-detail-section">';
    html += '<h3>Run Detail</h3>';
    html += '<div class="plugin-card-row"><span class="stat-label">Run</span><span class="stat-value">' + escapeHtml(run.run_id) + '</span></div>';
    html += '<div class="plugin-card-row"><span class="stat-label">Status</span><span class="stat-value">' + badge(run.status, run.status === 'failed' ? 'error' : run.status === 'awaiting_approval' ? 'warn' : 'ok') + '</span></div>';
    html += '<div class="plugin-card-row"><span class="stat-label">Started</span><span class="stat-value">' + formatTime(run.started_at) + '</span></div>';
    if (run.finished_at) {
      html += '<div class="plugin-card-row"><span class="stat-label">Finished</span><span class="stat-value">' + formatTime(run.finished_at) + '</span></div>';
    }
    if (run.summary) {
      html += '<div class="plugin-card-row"><span class="stat-label">Scanned</span><span class="stat-value">' + (run.summary.notesScanned || 0) + '</span></div>';
      html += '<div class="plugin-card-row"><span class="stat-label">Proposals</span><span class="stat-value">' + (run.summary.proposalsCreated || 0) + '</span></div>';
      if (run.summary.appliedCount !== undefined) {
        html += '<div class="plugin-card-row"><span class="stat-label">Applied</span><span class="stat-value">' + run.summary.appliedCount + '</span></div>';
      }
    }
    if (run.error_message) {
      html += '<div class="plugin-card-note" style="color:var(--danger)">' + escapeHtml(run.error_message) + '</div>';
    }
    var hasPending = detail.items.some(function(item) { return item.status === 'suggested' || item.status === 'approved'; });
    if (hasPending) {
      html += '<div class="plugin-card-actions">';
      html += '<button class="btn btn-muted" onclick="approveAllRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Approve all</button>';
      html += '<button class="btn btn-muted" onclick="rejectAllRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Reject all</button>';
      html += '<button class="btn btn-primary" onclick="applyApprovedRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Apply approved</button>';
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="plugin-detail-section">';
    html += '<h3>Proposed Changes</h3>';
    if (!detail.items || detail.items.length === 0) {
      html += '<div class="plugin-card-note">No proposed changes.</div>';
    } else {
      html += '<div class="plugin-run-items">';
      for (var i = 0; i < detail.items.length; i++) {
        var item = detail.items[i];
        html += '<div class="plugin-run-item">';
        html += '<div class="plugin-card-row"><span class="stat-label">Status</span><span class="stat-value">' + badge(item.status, item.status === 'failed' ? 'error' : item.status === 'applied' ? 'ok' : item.status === 'rejected' ? 'muted' : 'warn') + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Old title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.oldTitle) || (item.before && item.before.title) || 'Unknown') + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Proposed title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.proposedTitle) || (item.after && item.after.newTitle) || 'Unknown') + '</span></div>';
        html += '<div class="plugin-card-note">' + escapeHtml(item.reason || '') + '</div>';
        if (item.failure_message) {
          html += '<div class="plugin-card-note" style="color:var(--danger)">' + escapeHtml(item.failure_message) + '</div>';
        }
        if (item.status === 'suggested' || item.status === 'approved') {
          html += '<div class="plugin-run-item-actions">';
          html += '<button class="btn btn-muted" onclick="approveRunItem(\\'' + run.run_id + '\\',' + item.id + ')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Approve</button>';
          html += '<button class="btn btn-muted" onclick="rejectRunItem(\\'' + run.run_id + '\\',' + item.id + ')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Reject</button>';
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="plugin-detail-section">';
    html += '<h3>Run Logs</h3>';
    if (!detail.logs || detail.logs.length === 0) {
      html += '<div class="plugin-card-note">No log entries.</div>';
    } else {
      html += '<div class="plugin-log-list">';
      for (var j = 0; j < detail.logs.length; j++) {
        var entry = detail.logs[j];
        html += '<div class="plugin-log-entry">';
        html += '<div><strong>' + escapeHtml(entry.level.toUpperCase()) + '</strong> · ' + escapeHtml(formatTime(entry.timestamp)) + '</div>';
        html += '<div>' + escapeHtml(entry.message) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderPlugins(t) {
    if (!t || t.error) return '';
    var html = '';
    var sched = t.scheduler || {};
    var isBusy = sched.running;
    var canManagePlugins = Boolean(authToken);

    html += '<div class="plugin-toolbar">';
    html += '<div class="plugin-toolbar-copy">';
    html += '<span class="plugin-toolbar-label">Automation Runtime</span>';
    html += '<span class="plugin-toolbar-value">' + (sched.phase === 'running' ? 'Running plugin jobs' : 'Built-in plugins only') + '</span>';
    html += '</div>';
    html += '<div class="plugin-toolbar-actions">';
    html += '<span class="plugin-auth-note">' + (canManagePlugins ? 'Signed in for automation controls' : 'Log in to run, configure, and approve changes') + '</span>';
    if (canManagePlugins) {
      html += '<span>' + badge('Signed in', 'ok') + '</span>';
      html += '<button class="action-link" onclick="logoutDashboard()">Sign out</button>';
    } else {
      html += '<button class="btn btn-muted" onclick="loginDashboard()">Log in</button>';
    }
    html += '</div>';
    html += '</div>';

    if (!t.plugins || t.plugins.length === 0) {
      html += '<div class="plugin-card-grid-empty">No built-in automations registered.</div>';
    }

    if (t.plugins && t.plugins.length > 0) {
      html += '<div class="plugin-grid" id="plugin-grid">';
      for (var i = 0; i < t.plugins.length; i++) {
        var tr = t.plugins[i];
        html += '<article class="plugin-card" data-plugin-card="' + escapeHtml(tr.id) + '">';
        html += '<div class="plugin-card-header">';
        html += '<div>';
        html += '<div class="plugin-card-title">' + escapeHtml(tr.name) + '</div>';
        html += '<div class="plugin-card-subtitle">' + escapeHtml(tr.description) + '</div>';
        html += '</div>';
        html += '<div class="plugin-switch-wrap">';
        html += '<input class="plugin-switch" data-plugin-switch="' + escapeHtml(tr.id) + '" type="checkbox"' + (tr.enabled ? ' checked' : '') + (!canManagePlugins || isBusy ? ' disabled' : '') + ' onchange="togglePlugin(\\'' + tr.id + '\\', this.checked)">';
        html += '<span class="plugin-switch-state">' + (tr.enabled ? 'On' : 'Off') + '</span>';
        html += '</div>';
        html += '</div>';

        html += '<div class="plugin-meta-row">';
        html += '<span class="plugin-pill">' + escapeHtml(scheduleSummary(tr.schedule)) + '</span>';
        html += '<span class="plugin-pill">' + (tr.auto_apply ? 'Auto-apply on' : 'Preview first') + '</span>';
        html += '<span class="plugin-pill">' + tr.pending_approval_count + ' pending approvals</span>';
        html += '</div>';

        html += '<div class="plugin-card-section">';
        html += '<div class="plugin-card-row"><span class="stat-label">Next run</span><span class="stat-value">' + formatTime(tr.next_run_at) + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Last run</span><span class="stat-value">' + (tr.last_run ? formatTime(tr.last_run.finished_at || tr.last_run.started_at) : 'Never') + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Last result</span><span class="stat-value">' + (tr.last_run ? badge(tr.last_run.status, tr.last_run.status === 'failed' ? 'error' : tr.last_run.status === 'awaiting_approval' ? 'warn' : 'ok') : badge('Never', 'muted')) + '</span></div>';
        html += '</div>';

        html += '<div class="plugin-card-section">';
        html += '<div class="plugin-config-grid">';
        html += '<div class="plugin-config-field"><label>Schedule</label><select data-schedule-kind' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>';
        html += '<option value="manual"' + (tr.schedule.kind === 'manual' ? ' selected' : '') + '>Manual</option>';
        html += '<option value="daily"' + (tr.schedule.kind === 'daily' ? ' selected' : '') + '>Daily</option>';
        html += '<option value="weekly"' + (tr.schedule.kind === 'weekly' ? ' selected' : '') + '>Weekly</option>';
        html += '</select></div>';
        html += '<div class="plugin-config-field"><label>Time</label><input type="time" data-schedule-time value="' + escapeHtml(tr.schedule.time || '03:00') + '"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '></div>';
        html += '<div class="plugin-config-field"><label>Weekly day</label><select data-schedule-day' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>';
        for (var day = 0; day < 7; day++) {
          html += '<option value="' + day + '"' + (tr.schedule.day === day ? ' selected' : '') + '>' + dayLabel(day) + '</option>';
        }
        html += '</select></div>';
        html += '<div class="plugin-config-field"><label>Auto-apply</label><input type="checkbox" data-auto-apply' + (tr.auto_apply ? ' checked' : '') + (!canManagePlugins || isBusy ? ' disabled' : '') + '></div>';
        for (var f = 0; f < (tr.config_schema || []).length; f++) {
          var field = tr.config_schema[f];
          var value = tr.config && tr.config[field.key] !== undefined ? tr.config[field.key] : field.default;
          html += renderPluginConfigField(tr.id, field, value, !canManagePlugins || isBusy);
        }
        html += '</div>';
        html += '</div>';

        html += '<div class="plugin-card-section">';
        html += '<div class="plugin-card-row"><span class="stat-label">Recent runs</span><span class="stat-value">' + ((tr.recent_runs && tr.recent_runs.length) || 0) + '</span></div>';
        if (tr.recent_runs && tr.recent_runs.length > 0) {
          html += '<div class="plugin-run-list">';
          for (var r = 0; r < tr.recent_runs.length; r++) {
            var run = tr.recent_runs[r];
            html += '<div class="plugin-run-entry">';
            html += '<div class="plugin-run-entry-copy">';
            html += '<span>' + badge(run.status, run.status === 'failed' ? 'error' : run.status === 'awaiting_approval' ? 'warn' : 'ok') + '</span>';
            html += '<span>' + escapeHtml(run.trigger_type) + ' · ' + escapeHtml(formatTime(run.started_at)) + '</span>';
            html += '</div>';
            html += '<div class="plugin-run-entry-actions">';
            html += '<button class="btn btn-muted" onclick="viewPluginRun(\\'' + run.run_id + '\\')"' + (!canManagePlugins ? ' disabled' : '') + '>View</button>';
            html += '</div>';
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';

        html += '<div class="plugin-card-actions">';
        html += '<button class="btn btn-primary" onclick="triggerPlugin(\\'' + tr.id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Run now</button>';
        html += '<button class="btn btn-muted" onclick="savePluginConfig(\\'' + tr.id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Save settings</button>';
        if (tr.last_run && tr.last_run.run_id) {
          html += '<button class="action-link" onclick="viewPluginRun(\\'' + tr.last_run.run_id + '\\')"' + (!canManagePlugins ? ' disabled' : '') + '>Open latest run</button>';
        }
        html += '</div>';
        html += '</article>';
      }
      html += '</div>';
    }

    if (activePluginRunDetail) {
      html += renderRunDetail(activePluginRunDetail, canManagePlugins, isBusy);
    }

    if (sched.last_error) {
      html += '<div style="border-top:1px solid var(--surface);margin:0.5rem 0"></div>';
      html += '<div class="stat-row"><span class="stat-label">Runtime error</span><span class="stat-value" style="color:var(--danger);font-size:0.8rem">' + escapeHtml(sched.last_error) + '</span></div>';
    }

    if (sched.phase && sched.phase !== 'idle') {
      var phaseLabel = sched.phase === 'downloading_model' ? 'Downloading model...'
        : sched.phase === 'loading_model' ? 'Loading model...'
        : sched.phase === 'running' ? 'Running automation...'
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

      if (activePluginRunId && authToken) {
        try {
          const detailRes = await fetch('/plugins/runs/' + activePluginRunId, {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (detailRes.ok) {
            activePluginRunDetail = await detailRes.json();
          } else if (detailRes.status === 401) {
            clearAuthToken();
            activePluginRunId = null;
            activePluginRunDetail = null;
          } else {
            activePluginRunDetail = null;
          }
        } catch {
          activePluginRunDetail = null;
        }
      } else if (!authToken) {
        activePluginRunId = null;
        activePluginRunDetail = null;
      }

      // Render plugins section
      var tCard = $('plugins-card');
      if (tCard) {
        if (data.plugins && !data.plugins.error) {
          tCard.style.display = '';
          $('plugins-content').innerHTML = renderPlugins(data.plugins);
        } else {
          tCard.style.display = 'none';
        }
      }

      $('error-banner').style.display = 'none';

      // Poll faster during active work (download/indexing/plugins)
      const sched = data.search && data.search.scheduler;
      const tSched = data.plugins && data.plugins.scheduler;
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

  window.loginDashboard = async function() {
    const token = await getToken('manage plugins');
    if (token) refresh();
  };

  window.logoutDashboard = function() {
    clearAuthToken();
    refresh();
  };

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
        refresh();
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
        refresh();
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

  window.triggerPlugin = async function(id) {
    const token = await getToken('run plugin');
    if (!token) return;
    try {
      const res = await fetch('/plugins/' + id + '/run', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to run plugin');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.savePluginConfig = async function(id) {
    const token = await getToken('save automation settings');
    if (!token) return;
    var card = document.querySelector('[data-plugin-card="' + id + '"]');
    if (!card) return;

    var body = {
      schedule_kind: card.querySelector('[data-schedule-kind]').value,
      schedule_time: card.querySelector('[data-schedule-time]').value,
      schedule_day: Number(card.querySelector('[data-schedule-day]').value),
      auto_apply: card.querySelector('[data-auto-apply]').checked,
      config: {}
    };

    var configFields = card.querySelectorAll('[data-plugin-config-field]');
    for (var i = 0; i < configFields.length; i++) {
      var input = configFields[i];
      var key = input.getAttribute('data-plugin-config-field');
      if (!key) continue;
      if (input.type === 'checkbox') {
        body.config[key] = input.checked;
      } else if (input.type === 'number') {
        body.config[key] = Number(input.value);
      } else {
        body.config[key] = input.value;
      }
    }

    try {
      const res = await fetch('/plugins/' + id + '/config', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save settings');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.togglePlugin = async function(id, enabled) {
    const token = await getToken(enabled ? 'enable plugin' : 'disable plugin');
    if (!token) return;
    try {
      const res = await fetch('/plugins/' + id + '/' + (enabled ? 'enable' : 'disable'), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update plugin');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.viewPluginRun = async function(runId) {
    const token = await getToken('view plugin run');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to load run detail');
        return;
      }
      activePluginRunId = runId;
      activePluginRunDetail = data;
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.approveRunItem = async function(runId, itemId) {
    const token = await getToken('approve plugin change');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId + '/items/' + itemId + '/approve', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to approve change');
        return;
      }
      activePluginRunId = runId;
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.rejectRunItem = async function(runId, itemId) {
    const token = await getToken('reject plugin change');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId + '/items/' + itemId + '/reject', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to reject change');
        return;
      }
      activePluginRunId = runId;
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.approveAllRunItems = async function(runId) {
    const token = await getToken('approve all plugin changes');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId + '/approve-all', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to approve all changes');
        return;
      }
      activePluginRunId = runId;
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.rejectAllRunItems = async function(runId) {
    const token = await getToken('reject all plugin changes');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId + '/reject-all', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to reject all changes');
        return;
      }
      activePluginRunId = runId;
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.applyApprovedRunItems = async function(runId) {
    const token = await getToken('apply approved plugin changes');
    if (!token) return;
    try {
      const res = await fetch('/plugins/runs/' + runId + '/apply-approved', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to apply approved changes');
        return;
      }
      activePluginRunId = runId;
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
