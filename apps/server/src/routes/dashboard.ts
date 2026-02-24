import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { isSetupComplete } from '../db/auth.js';
import { loadConfig } from '../config.js';

const dashboard = new Hono();

// Track server start time for uptime
const startedAt = Date.now();

// ── JSON status endpoint (unauthenticated) ──────────────────────────
dashboard.get('/dashboard/status', (c) => {
  const db = getDb();
  const config = loadConfig();

  const notesCount = (db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number }).count;
  const sessionsCount = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;

  let search = null;
  if (config.searchEnabled) {
    try {
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
      };
    } catch {
      search = { enabled: true, error: 'Search tables not initialized' };
    }
  } else {
    search = { enabled: false };
  }

  return c.json({
    notes_count: notesCount,
    sessions_count: sessionsCount,
    setup_complete: isSetupComplete(db),
    search,
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
<title>FUTO Notes — Server Dashboard</title>
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

  @media (max-width: 480px) {
    body { padding: 1rem 0.75rem; }
    .download-grid { grid-template-columns: 1fr; }
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
      <li>Download FUTO Notes on your device using a link above</li>
      <li>Open the app, go to <strong>Settings → Sync</strong>, and enter this server's URL: <code id="server-url">...</code></li>
      <li>Enter the password you set during server setup and tap <strong>Connect</strong></li>
    </ol>
  </div>

  <div class="footer">
    <a href="https://notes.futo.org">FUTO Notes</a> · <a href="https://futo.org">FUTO</a>
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

  function renderSearch(s) {
    if (!s || !s.enabled) {
      return '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Disabled', 'muted') + '</div>';
    }
    if (s.error) {
      return '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Error', 'error') + '</div>' +
        '<div class="stat-row"><span class="stat-label">Details</span><span class="stat-value">' + s.error + '</span></div>';
    }

    let html = '';

    // Indexing status
    if (s.current_job) {
      const pct = s.current_job.notes_total
        ? Math.round((s.current_job.notes_processed / s.current_job.notes_total) * 100)
        : 0;
      html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Indexing', 'warn') + '</div>';
      html += '<div class="stat-row"><span class="stat-label">Progress</span><span class="stat-value">' +
        s.current_job.notes_processed + ' / ' + (s.current_job.notes_total || '?') + ' notes</span></div>';
      html += '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
    } else if (s.dirty_count > 0) {
      html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Pending', 'warn') + '</div>';
      html += '<div class="stat-row"><span class="stat-label">Queued</span><span class="stat-value">' + s.dirty_count + ' notes</span></div>';
    } else {
      html += '<div class="stat-row"><span class="stat-label">Status</span>' + badge('Up to date', 'ok') + '</div>';
    }

    // Model
    if (s.model) {
      html += '<div class="stat-row"><span class="stat-label">Model</span><span class="stat-value">' + s.model + '</span></div>';
    }

    // Chunks indexed
    html += '<div class="stat-row"><span class="stat-label">Chunks indexed</span><span class="stat-value">' + (s.chunk_count || 0).toLocaleString() + '</span></div>';

    // Last indexed
    html += '<div class="stat-row"><span class="stat-label">Last indexed</span><span class="stat-value">' + formatTime(s.last_indexed_at) + '</span></div>';

    // Last run error
    if (s.last_run && s.last_run.status === 'failed' && s.last_run.error_message) {
      html += '<div class="stat-row"><span class="stat-label">Last error</span><span class="stat-value" style="color:var(--danger)">' + s.last_run.error_message + '</span></div>';
    }

    return html;
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
      $('error-banner').style.display = 'none';
    } catch (e) {
      $('status').innerHTML = badge('Unreachable', 'error');
      $('error-banner').textContent = 'Could not reach server: ' + e.message;
      $('error-banner').style.display = 'block';
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>

</body>
</html>`;
}

export default dashboard;
