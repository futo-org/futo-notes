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
    --black: #0c0c0c;
    --white: #f0f0f0;
    --accent: #ff5533;
    --accent-hover: #ff7755;
    --gray: #999;
    --gray-light: #bbb;
    --border: #333;
    --border-light: #444;
    --surface: #151515;
    --surface-hover: #1c1c1c;
    --success: #5cdb6f;
    --success-dim: #2a5e32;
    --danger: #ff5533;
    --muted: #666;
    --radius: 0;
  }

  /* Skip-to-content link */
  .skip-link {
    position: absolute;
    top: -100%;
    left: 1rem;
    background: var(--accent);
    color: var(--black);
    padding: 0.5rem 1rem;
    font-weight: 700;
    z-index: 9999;
    text-decoration: none;
  }
  .skip-link:focus {
    top: 1rem;
  }

  /* Focus visible for accessibility */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  body {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    background: var(--black);
    color: var(--white);
    line-height: 1.6;
    min-height: 100vh;
    padding: 0;
    position: relative;
  }

  /* Grain overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 0;
  }

  body > * {
    position: relative;
    z-index: 1;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 2rem 4rem;
  }

  /* Header */
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2.5rem 0 2rem;
    border-bottom: 3px solid var(--white);
    margin-bottom: 2.5rem;
  }

  header .header-left h1 {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 2.6rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--white);
    line-height: 1;
  }

  header .header-left p {
    color: var(--gray);
    margin-top: 0.35rem;
    font-size: 0.8rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  header .header-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8rem;
    color: var(--gray);
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .card h2 {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gray-light);
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  /* Section wrapper for search/plugins */
  .section {
    border: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .section-head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-head h2 {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gray-light);
    margin: 0;
    padding: 0;
    border: none;
  }

  .section-body {
    padding: 1.5rem;
    background: var(--surface);
  }

  /* Stats */
  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0;
  }

  .stat-row + .stat-row {
    border-top: 1px solid var(--border);
  }

  .stat-label {
    color: var(--gray);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .stat-value {
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--white);
  }

  /* Stats grid for top section */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .stats-grid .stat-cell {
    background: var(--surface);
    padding: 1.25rem 1.5rem;
  }

  .stats-grid .stat-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.65rem;
  }

  .stats-grid .stat-value {
    display: block;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--white);
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 0;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid;
  }

  .badge-ok { background: var(--success-dim); color: var(--success); border-color: var(--success); }
  .badge-warn { background: #3d2e00; color: #ffbb33; border-color: #ffbb33; }
  .badge-error { background: #3d1510; color: var(--danger); border-color: var(--danger); }
  .badge-muted { background: var(--surface); color: var(--gray); border-color: var(--border); }

  /* Progress */
  .progress-track {
    width: 100%;
    height: 4px;
    background: var(--border);
    border-radius: 0;
    margin-top: 0.5rem;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 0;
    transition: width 0.4s ease;
  }

  /* Buttons */
  .btn {
    display: inline-block;
    padding: 0.5rem 1.2rem;
    border-radius: 0;
    font-size: 0.75rem;
    font-weight: 700;
    font-family: inherit;
    border: 1px solid;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--black);
    border-color: var(--accent);
  }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-muted {
    background: transparent;
    color: var(--gray-light);
    border-color: var(--border-light);
  }
  .btn-muted:hover { background: var(--surface-hover); color: var(--white); }
  .btn-muted:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-danger {
    background: var(--danger);
    color: var(--black);
    border-color: var(--danger);
    font-weight: 700;
  }
  .btn-danger:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-danger:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .action-link {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .action-link:hover {
    color: var(--accent-hover);
  }
  .action-link:disabled {
    color: var(--gray);
    text-decoration: none;
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Downloads */
  .download-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--border);
  }

  .download-link {
    display: block;
    text-align: center;
    padding: 0.85rem 1rem;
    background: var(--surface);
    color: var(--white);
    text-decoration: none;
    border-radius: 0;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: background 0.1s;
  }

  .download-link:hover {
    background: var(--surface-hover);
    color: var(--accent);
  }

  /* Inputs */
  .text-input {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    border-radius: 0;
    border: 1px solid var(--border);
    background: var(--black);
    color: var(--white);
    font: inherit;
    font-size: 0.85rem;
  }

  .text-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-color: var(--accent);
  }

  /* Setup steps */
  .setup-steps {
    list-style: none;
    counter-reset: step;
  }

  .setup-steps li {
    counter-increment: step;
    padding: 0.75rem 0;
    padding-left: 2.5rem;
    position: relative;
    font-size: 0.85rem;
    color: var(--gray-light);
  }

  .setup-steps li + li {
    border-top: 1px solid var(--border);
  }

  .setup-steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    width: 1.5rem;
    height: 1.5rem;
    background: var(--accent);
    color: var(--black);
    border-radius: 0;
    font-size: 0.75rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    top: 0.7rem;
  }

  .setup-steps code {
    background: var(--black);
    border: 1px solid var(--border);
    padding: 0.1rem 0.4rem;
    border-radius: 0;
    font-size: 0.8rem;
    color: var(--accent);
  }

  /* Footer */
  .footer {
    text-align: center;
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    color: var(--gray);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .footer a {
    color: var(--accent);
    text-decoration: none;
  }

  .footer a:hover {
    text-decoration: underline;
  }

  /* Error banner */
  #error-banner {
    display: none;
    background: var(--surface);
    border: 2px solid var(--accent);
    border-radius: 0;
    padding: 0.85rem 1rem;
    margin-bottom: 1.5rem;
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .loading { color: var(--gray); }

  /* Danger zone */
  .danger-card {
    border: 2px solid var(--accent);
    background: var(--surface);
  }

  .danger-card h2 {
    color: var(--accent);
    border-bottom-color: var(--border);
  }

  .danger-copy {
    font-size: 0.85rem;
    color: var(--white);
    margin-bottom: 0.25rem;
    font-weight: 700;
  }

  .danger-callout {
    font-size: 0.8rem;
    color: var(--gray-light);
  }

  .danger-list {
    margin: 0.65rem 0 1rem 1.1rem;
    color: var(--gray);
    font-size: 0.8rem;
  }

  .danger-list li + li {
    margin-top: 0.3rem;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
  }

  .modal-backdrop.open {
    display: flex;
  }

  /* Danger modal */
  .danger-modal {
    width: min(540px, 100%);
    border: 2px solid var(--danger);
    border-radius: 0;
    background: #0c0c0c;
    padding: 1.5rem;
    box-shadow: 0 0 40px rgba(255, 85, 51, 0.15);
  }

  .danger-modal h3 {
    color: var(--danger);
    font-size: 1rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.75rem;
  }

  .danger-modal p {
    font-size: 0.82rem;
    color: var(--gray-light);
  }

  .danger-modal ul {
    margin: 0.65rem 0 0.75rem 1.2rem;
    font-size: 0.8rem;
    color: var(--gray);
  }

  .danger-modal ul li + li {
    margin-top: 0.25rem;
  }

  .danger-modal label {
    display: block;
    font-size: 0.75rem;
    color: var(--danger);
    font-weight: 700;
    margin-bottom: 0.35rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .danger-input {
    width: 100%;
    border: 1px solid var(--danger);
    border-radius: 0;
    padding: 0.5rem 0.65rem;
    font-family: inherit;
    font-size: 0.85rem;
    color: var(--white);
    background: var(--black);
  }

  .danger-input:focus {
    outline: none;
    border-color: var(--accent-hover);
    box-shadow: 0 0 0 2px rgba(255, 85, 51, 0.25);
  }

  .danger-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .danger-final {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--gray);
    font-weight: 600;
  }

  /* Plugin editor modal */
  .plugin-editor-modal {
    width: min(900px, 100%);
    max-height: min(90vh, 860px);
    overflow: auto;
    border: 2px solid var(--border-light);
    border-radius: 0;
    background: var(--black);
    padding: 1.5rem;
    box-shadow: 0 0 60px rgba(0, 0, 0, 0.6);
    display: grid;
    gap: 1rem;
  }

  .plugin-editor-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
  }

  .plugin-editor-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--white);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .plugin-editor-copy {
    font-size: 0.8rem;
    color: var(--gray);
    margin-top: 0.3rem;
  }

  .plugin-editor-grid {
    display: grid;
    gap: 0.8rem;
  }

  .plugin-editor-field {
    display: grid;
    gap: 0.35rem;
  }

  .plugin-editor-field label {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--gray);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .plugin-editor-input,
  .plugin-editor-textarea {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
    color: var(--white);
    font: inherit;
  }

  .plugin-editor-input {
    padding: 0.55rem 0.65rem;
  }

  .plugin-editor-textarea {
    min-height: 360px;
    padding: 0.75rem 0.85rem;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.55;
    resize: vertical;
    white-space: pre;
  }

  .plugin-editor-note {
    font-size: 0.75rem;
    color: var(--gray);
  }

  .plugin-editor-error {
    display: none;
    border: 1px solid var(--danger);
    border-radius: 0;
    padding: 0.7rem 0.8rem;
    background: #1a0a08;
    color: var(--danger);
    font-size: 0.82rem;
    white-space: pre-wrap;
  }

  .plugin-editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.55rem;
    flex-wrap: wrap;
  }

  .run-all-modal {
    width: min(640px, 100%);
    max-height: min(85vh, 760px);
    overflow: auto;
    border: 2px solid var(--border-light);
    border-radius: 0;
    background: var(--black);
    padding: 1.5rem;
    box-shadow: 0 0 60px rgba(0, 0, 0, 0.6);
    display: grid;
    gap: 1rem;
  }

  .run-all-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .run-all-modal-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--white);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .run-all-modal-copy {
    margin-top: 0.3rem;
    font-size: 0.8rem;
    color: var(--gray);
  }

  .run-all-batch-list {
    display: grid;
    gap: 0.6rem;
  }

  .run-all-batch-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 0.9rem;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .run-all-batch-indicator {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    color: var(--gray);
    font-size: 0.75rem;
    font-weight: 700;
  }

  .run-all-batch-indicator-running {
    border-color: var(--accent);
  }

  .run-all-batch-spinner {
    width: 0.8rem;
    height: 0.8rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .run-all-batch-indicator-success {
    border-color: var(--success);
    color: var(--success);
  }

  .run-all-batch-indicator-error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .run-all-batch-name {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--white);
  }

  .run-all-batch-note {
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: var(--gray);
  }

  .run-all-batch-status {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--gray-light);
  }

  .run-all-batch-footer {
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
    font-size: 0.78rem;
    color: var(--gray);
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* Plugin card local variant */
  .plugin-card-local {
    border-color: var(--accent);
    background: #1a0f0c;
  }

  .plugin-pill.plugin-pill-local {
    background: #1a0f0c;
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Search section */
  .index-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .index-status {
    font-size: 0.75rem;
    color: var(--gray);
  }

  .phase-label {
    font-size: 0.75rem;
    color: var(--gray);
    font-style: italic;
  }

  .search-dimmed {
    opacity: 0.4;
    pointer-events: none;
  }

  /* Plugin toolbar */
  .plugin-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.2rem 0 0.9rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }

  .plugin-toolbar-copy {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .plugin-toolbar-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--gray);
    font-weight: 700;
  }

  .plugin-toolbar-value {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--white);
  }

  .plugin-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .plugin-auth-note {
    font-size: 0.75rem;
    color: var(--gray);
  }

  /* Plugin grid */
  .plugin-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    background: var(--border);
  }

  .plugin-card-grid-empty {
    border: 1px dashed var(--border-light);
    border-radius: 0;
    padding: 1.25rem;
    color: var(--gray);
    font-size: 0.85rem;
    background: var(--surface);
  }

  .plugin-card {
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 1.25rem;
    background: var(--surface);
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
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--white);
  }

  .plugin-card-subtitle {
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: var(--gray);
  }

  /* Plugin toggle switch */
  .plugin-switch-wrap {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-shrink: 0;
  }

  .plugin-switch {
    appearance: none;
    width: 2.4rem;
    height: 1.3rem;
    border-radius: 0;
    border: 2px solid var(--gray);
    background: transparent;
    position: relative;
    cursor: pointer;
    transition: border-color 0.2s ease, opacity 0.2s ease;
  }

  .plugin-switch::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 0;
    background: var(--gray);
    transition: transform 0.2s ease, background 0.2s ease;
  }

  .plugin-switch:checked {
    border-color: var(--success);
    background: transparent;
  }

  .plugin-switch:checked::before {
    transform: translateX(1.1rem);
    background: var(--success);
  }

  .plugin-switch:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .plugin-switch-state {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--gray);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Plugin pills / meta */
  .plugin-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .plugin-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    border-radius: 0;
    background: var(--black);
    border: 1px solid var(--border);
    color: var(--gray);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Plugin card sections */
  .plugin-card-section {
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
    display: grid;
    gap: 0.45rem;
  }

  .plugin-card-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    font-size: 0.8rem;
  }

  .plugin-card-row .stat-label {
    font-size: 0.75rem;
  }

  .plugin-card-row .stat-value {
    font-size: 0.78rem;
    text-align: right;
  }

  .plugin-card-row .stat-value.plugin-source {
    max-width: 60%;
    word-break: break-word;
  }

  .plugin-card-note {
    font-size: 0.75rem;
    color: var(--gray);
  }

  .plugin-card-note.plugin-card-warning {
    color: #ffbb33;
    font-weight: 700;
  }

  .plugin-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    margin-top: auto;
    padding-top: 0.25rem;
  }

  /* Plugin config */
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
    font-size: 0.7rem;
    color: var(--gray);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .plugin-config-field input,
  .plugin-config-field select {
    width: 100%;
    padding: 0.45rem 0.55rem;
    border-radius: 0;
    border: 1px solid var(--border);
    background: var(--black);
    color: var(--white);
    font: inherit;
    font-size: 0.85rem;
  }

  .plugin-config-field input[type="checkbox"] {
    width: auto;
    padding: 0;
  }

  /* Tag pills */
  .plugin-tag-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    min-height: 1.8rem;
  }

  .tag-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-family: inherit;
    font-weight: 600;
    border: 1px solid var(--border-light);
    background: transparent;
    color: var(--gray);
    cursor: pointer;
    transition: all 0.12s;
    user-select: none;
  }

  .tag-pill:hover {
    border-color: var(--accent);
    color: var(--gray-light);
  }

  .tag-pill.active {
    background: var(--accent);
    color: var(--black);
    border-color: var(--accent);
  }

  .tag-pill.active:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .tag-pill:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  [data-tag-list-root] {
    grid-column: 1 / -1;
  }

  .tag-pill-actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }

  .plugin-tag-empty {
    font-size: 0.75rem;
    color: var(--muted);
    font-style: italic;
  }

  /* Plugin run list */
  .plugin-run-list {
    display: grid;
    gap: 0.45rem;
  }

  .plugin-run-entry {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.75rem;
    border-radius: 0;
    border: 1px solid var(--border);
    background: var(--black);
  }

  .plugin-run-entry-copy {
    display: grid;
    gap: 0.15rem;
    font-size: 0.78rem;
  }

  .plugin-run-entry-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  /* Plugin detail */
  .plugin-detail {
    margin-top: 1rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    display: grid;
    gap: 0.9rem;
  }

  .plugin-detail-section {
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--black);
    padding: 1rem;
  }

  .plugin-detail-section h3 {
    font-size: 0.85rem;
    margin-bottom: 0.65rem;
    color: var(--white);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .plugin-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    margin-bottom: 0.65rem;
  }

  .plugin-detail-header h3 {
    margin-bottom: 0;
  }

  .plugin-detail-group-label {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0.25rem 0 0.2rem;
  }

  .plugin-run-items {
    display: grid;
    gap: 0.6rem;
  }

  .plugin-run-item {
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 0.85rem;
    display: grid;
    gap: 0.45rem;
    background: var(--surface);
  }

  .plugin-run-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .plugin-log-list {
    display: grid;
    gap: 0.4rem;
    font-size: 0.78rem;
  }

  .plugin-log-entry {
    display: grid;
    gap: 0.2rem;
    padding: 0.55rem 0.7rem;
    border-radius: 0;
    background: var(--surface);
    border-left: 2px solid var(--border);
  }

  /* Responsive */
  @media (max-width: 900px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 760px) {
    .plugin-grid { grid-template-columns: 1fr; }
    .plugin-config-grid { grid-template-columns: 1fr; }
    header { flex-direction: column; align-items: flex-start; gap: 1rem; }
  }

  @media (max-width: 480px) {
    body { padding: 0; }
    .container { padding: 0 1rem 3rem; }
    .stats-grid { grid-template-columns: 1fr; }
    .download-grid { grid-template-columns: 1fr; }
    .danger-actions { flex-direction: column-reverse; }
    .danger-actions .btn { width: 100%; }
    .plugin-card-header { flex-direction: column; }
    .plugin-switch-wrap { width: 100%; justify-content: space-between; }
    header .header-left h1 { font-size: 1.8rem; }
  }
</style>
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>

<div class="container">
  <header>
    <div class="header-left">
      <h1>STONEFRUIT</h1>
      <p>Server Dashboard</p>
    </div>
    <div class="header-right" aria-label="Server status">
      <span class="live-dot" aria-hidden="true"></span>
      <span>Server Online</span>
      <span aria-hidden="true">/</span>
      <span id="uptime"><span class="loading">...</span></span>
    </div>
  </header>

  <main id="main">
    <div id="error-banner"></div>

    <!-- Stats -->
    <div class="stats-grid" role="region" aria-label="Server statistics">
      <div class="stat-cell">
        <span class="stat-label">Notes</span>
        <span class="stat-value" id="notes-count"><span class="loading">...</span></span>
      </div>
      <div class="stat-cell">
        <span class="stat-label">Connected</span>
        <span class="stat-value" id="sessions-count"><span class="loading">...</span></span>
      </div>
      <div class="stat-cell">
        <span class="stat-label">Status</span>
        <span class="stat-value" id="status"><span class="loading">...</span></span>
      </div>
      <div class="stat-cell">
        <span class="stat-label">Setup</span>
        <span class="stat-value" id="setup"><span class="loading">...</span></span>
      </div>
    </div>

    <!-- Search / Indexing -->
    <section class="section" id="search-card" role="region" aria-label="Search and indexing">
      <div class="section-head">
        <h2>Search &amp; Indexing</h2>
      </div>
      <div class="section-body">
        <div id="search-content"><span class="loading">Loading...</span></div>
      </div>
    </section>

    <!-- Plugins -->
    <section class="section" id="plugins-card" style="display:none" role="region" aria-label="Automations">
      <div class="section-head">
        <h2>Automations</h2>
        <div class="section-head-actions">
          <button class="btn btn-primary" id="run-all-plugins-btn" onclick="triggerAllPlugins()" disabled>Run All</button>
        </div>
      </div>
      <div class="section-body">
        <div id="plugins-content"><span class="loading">Loading...</span></div>
      </div>
    </section>

    <!-- Download -->
    <div class="card" role="region" aria-label="Download apps">
      <h2>Download Apps</h2>
      <div class="download-grid">
        <a class="download-link" href="https://play.google.com/store/apps/details?id=org.futo.notes" target="_blank">Android</a>
        <a class="download-link" href="https://apps.apple.com/app/futo-notes/id0000000000" target="_blank">iOS</a>
        <a class="download-link" href="https://github.com/nickoehler/futo-notes-releases/releases" target="_blank">Desktop</a>
        <a class="download-link" href="https://notes.futo.org" target="_blank">Web</a>
      </div>
    </div>

    <!-- Setup Guide -->
    <div class="card" role="region" aria-label="Setup guide">
      <h2>Setup Guide</h2>
      <ol class="setup-steps">
        <li>Download Stonefruit on your device using a link above</li>
        <li>Open the app, go to <strong>Settings &rarr; Sync</strong>, and enter this server URL: <code id="server-url">...</code></li>
        <li>Enter the password you set during server setup and tap <strong>Connect</strong></li>
      </ol>
    </div>

    <!-- Danger Zone -->
    <div class="card danger-card" role="region" aria-label="Danger zone">
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
  </main>

  <div class="footer">
    <a href="https://notes.futo.org">Stonefruit</a> &middot; <a href="https://futo.org">FUTO</a>
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

<div id="plugin-editor-modal" class="modal-backdrop" aria-hidden="true">
  <div class="plugin-editor-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-editor-title">
    <div class="plugin-editor-header">
      <div>
        <div class="plugin-editor-title" id="plugin-editor-title">New Local Automation</div>
        <div class="plugin-editor-copy" id="plugin-editor-copy">Paste a TypeScript plugin module. It will be transpiled, validated, persisted on disk, and loaded immediately.</div>
      </div>
      <button class="btn btn-muted" id="plugin-editor-close-btn" onclick="closePluginEditor()">Close</button>
    </div>
    <div class="plugin-editor-grid">
      <div class="plugin-editor-field">
        <label for="plugin-editor-id">Plugin ID</label>
        <input id="plugin-editor-id" class="plugin-editor-input" type="text" autocomplete="off" spellcheck="false" placeholder="example-local-plugin">
        <div class="plugin-editor-note">Use lowercase letters, numbers, hyphens, or underscores. The exported plugin object's <code>id</code> must match.</div>
      </div>
      <div class="plugin-editor-field">
        <label for="plugin-editor-source">Plugin Source</label>
        <textarea id="plugin-editor-source" class="plugin-editor-textarea" spellcheck="false"></textarea>
      </div>
      <div id="plugin-editor-error" class="plugin-editor-error"></div>
    </div>
    <div class="plugin-editor-actions">
      <button class="btn btn-muted" id="plugin-editor-cancel-btn" onclick="closePluginEditor()">Cancel</button>
      <button class="btn btn-primary" id="plugin-editor-save-btn" onclick="saveLocalPlugin()">Save automation</button>
    </div>
  </div>
</div>

<div id="run-all-modal" class="modal-backdrop" aria-hidden="true">
  <div class="run-all-modal" role="dialog" aria-modal="true" aria-labelledby="run-all-modal-title">
    <div class="run-all-modal-header">
      <div>
        <div class="run-all-modal-title" id="run-all-modal-title">Run All Automations</div>
        <div class="run-all-modal-copy" id="run-all-modal-copy">Queued automations will start one at a time. The list updates as each run finishes.</div>
      </div>
      <button class="btn btn-muted" id="run-all-modal-close-btn" onclick="closeRunAllModal()">Close</button>
    </div>
    <div id="run-all-batch-content"><span class="loading">Preparing batch...</span></div>
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
  let activeRunAllBatchId = null;
  let activeRunAllBatch = null;
  let pluginEditorMode = 'create';
  let pluginEditorPluginId = null;
  let pluginDrafts = Object.create(null);

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function getPluginDraft(pluginId) {
    return pluginDrafts[pluginId] || null;
  }

  function ensurePluginDraft(pluginId) {
    if (!pluginDrafts[pluginId]) {
      pluginDrafts[pluginId] = { config: {} };
    } else if (!pluginDrafts[pluginId].config) {
      pluginDrafts[pluginId].config = {};
    }
    return pluginDrafts[pluginId];
  }

  function clearPluginDraft(pluginId) {
    delete pluginDrafts[pluginId];
  }

  function getPluginScheduleKind(plugin) {
    var draft = getPluginDraft(plugin.id);
    return draft && hasOwn(draft, 'schedule_kind') ? draft.schedule_kind : plugin.schedule.kind;
  }

  function getPluginScheduleTime(plugin) {
    var draft = getPluginDraft(plugin.id);
    return draft && hasOwn(draft, 'schedule_time') ? draft.schedule_time : (plugin.schedule.time || '03:00');
  }

  function getPluginScheduleDay(plugin) {
    var draft = getPluginDraft(plugin.id);
    return draft && hasOwn(draft, 'schedule_day') ? draft.schedule_day : plugin.schedule.day;
  }

  function getPluginAutoApply(plugin) {
    var draft = getPluginDraft(plugin.id);
    return draft && hasOwn(draft, 'auto_apply') ? draft.auto_apply : plugin.auto_apply;
  }

  function parseLegacyTagList(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    return value.split(',').map(function(entry) {
      var trimmed = entry.trim();
      var colonIdx = trimmed.indexOf(':');
      return {
        name: (colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed).trim(),
        description: (colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : '').trim(),
      };
    }).filter(function(item) {
      return item.name.length > 0;
    });
  }

  function normalizeTagListValue(value) {
    if (Array.isArray(value)) {
      return value.map(function(item) {
        return {
          name: item && typeof item.name === 'string' ? item.name : '',
          description: item && typeof item.description === 'string' ? item.description : '',
        };
      }).filter(function(item) {
        return item.name.trim().length > 0 || item.description.trim().length > 0;
      });
    }
    return parseLegacyTagList(value);
  }

  function getPluginConfigValue(plugin, field) {
    var draft = getPluginDraft(plugin.id);
    if (draft && draft.config && hasOwn(draft.config, field.key)) {
      return field.type === 'tag_list' ? normalizeTagListValue(draft.config[field.key]) : draft.config[field.key];
    }
    var value = plugin.config && plugin.config[field.key] !== undefined ? plugin.config[field.key] : field.default;
    return field.type === 'tag_list' ? normalizeTagListValue(value) : value;
  }

  function readTagListValue(card, key) {
    var root = card.querySelector('[data-tag-list="' + key + '"]');
    if (!root) return [];
    var pills = root.querySelectorAll('.tag-pill.active');
    var value = [];
    for (var i = 0; i < pills.length; i++) {
      var name = pills[i].getAttribute('data-tag-pill');
      if (name && name.trim().length > 0) {
        value.push({ name: name.trim(), description: '' });
      }
    }
    return value;
  }

  function isPluginConfigControl(target) {
    return Boolean(
      target &&
      target.closest &&
      target.closest('[data-plugin-card]') &&
      (
        target.hasAttribute('data-plugin-config-field') ||
        target.hasAttribute('data-tag-pill') ||
        target.hasAttribute('data-tag-check') ||
        target.closest('[data-tag-list-root]') ||
        target.hasAttribute('data-schedule-kind') ||
        target.hasAttribute('data-schedule-time') ||
        target.hasAttribute('data-schedule-day') ||
        target.hasAttribute('data-auto-apply')
      )
    );
  }

  function capturePluginDraft(target) {
    if (!isPluginConfigControl(target)) return;
    var card = target.closest('[data-plugin-card]');
    if (!card) return;
    var pluginId = card.getAttribute('data-plugin-card');
    if (!pluginId) return;
    var draft = ensurePluginDraft(pluginId);

    if (target.hasAttribute('data-tag-pill')) {
      target.classList.toggle('active');
      var tagListRoot = target.closest('[data-tag-list-root]');
      if (tagListRoot) {
        var tagListKey = tagListRoot.getAttribute('data-tag-list-root');
        if (tagListKey) {
          draft.config[tagListKey] = readTagListValue(card, tagListKey);
        }
      }
      return;
    }

    var tagListRoot = target.closest('[data-tag-list-root]');
    if (tagListRoot) {
      var tagListKey = tagListRoot.getAttribute('data-tag-list-root');
      if (!tagListKey) return;
      draft.config[tagListKey] = readTagListValue(card, tagListKey);
      return;
    }

    if (target.hasAttribute('data-plugin-config-field')) {
      var key = target.getAttribute('data-plugin-config-field');
      if (!key) return;
      draft.config[key] = target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
          ? Number(target.value)
          : target.value;
      return;
    }

    if (target.hasAttribute('data-schedule-kind')) {
      draft.schedule_kind = target.value;
      if (target.value !== 'weekly') {
        draft.schedule_day = null;
      } else if (!hasOwn(draft, 'schedule_day')) {
        var weeklyDayInput = card.querySelector('[data-schedule-day]');
        draft.schedule_day = weeklyDayInput ? Number(weeklyDayInput.value) : 1;
      }
      return;
    }

    if (target.hasAttribute('data-schedule-time')) {
      draft.schedule_time = target.value;
      return;
    }

    if (target.hasAttribute('data-schedule-day')) {
      draft.schedule_day = Number(target.value);
      return;
    }

    if (target.hasAttribute('data-auto-apply')) {
      draft.auto_apply = target.checked;
    }
  }

  function isPluginConfigEditing() {
    return isPluginConfigControl(document.activeElement);
  }

  function defaultLocalPluginSource() {
    return [
      'export default {',
      "  id: '__PLUGIN_ID__',",
      "  name: '__PLUGIN_NAME__',",
      "  description: 'Describe this automation.',",
      '  defaultEnabled: false,',
      "  defaultSchedule: { kind: 'manual', time: null, day: null },",
      '  defaultAutoApply: true,',
      '  configSchema: [],',
      '  async run(context) {',
      "    const notes = await context.sdk.findNotes({ limit: 5, sort: 'modified_desc' });",
      "    await context.sdk.log('info', 'Scanned recent notes', { count: notes.length });",
      '    return {',
      '      notesScanned: notes.length,',
      '      proposalsCreated: 0,',
      '      notesSkipped: 0,',
      '    };',
      '  },',
      '};',
    ].join('\\n');
  }

  function runAllBatchStatusLabel(status) {
    if (status === 'running') return 'Running';
    if (status === 'succeeded') return 'Done';
    if (status === 'failed') return 'Failed';
    return 'Queued';
  }

  function renderRunAllBatchIndicator(item) {
    if (item.status === 'running') {
      return '<span class="run-all-batch-indicator run-all-batch-indicator-running"><span class="run-all-batch-spinner" aria-hidden="true"></span></span>';
    }
    if (item.status === 'succeeded') {
      return '<span class="run-all-batch-indicator run-all-batch-indicator-success" aria-label="Completed">&#10003;</span>';
    }
    if (item.status === 'failed') {
      return '<span class="run-all-batch-indicator run-all-batch-indicator-error" aria-label="Failed">!</span>';
    }
    return '<span class="run-all-batch-indicator" aria-label="Queued">...</span>';
  }

  function renderRunAllBatch(batch) {
    if (!batch || !batch.items || batch.items.length === 0) {
      return '<div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">No automations queued.</span></div>';
    }

    var html = '<div class="run-all-batch-list">';
    for (var i = 0; i < batch.items.length; i++) {
      var item = batch.items[i];
      var note = '';
      if (item.status === 'running') {
        note = 'Running now';
      } else if (item.status === 'failed' && item.error_message) {
        note = item.error_message;
      } else if (item.status === 'succeeded' && item.run_status === 'awaiting_approval') {
        note = 'Finished and waiting for approval';
      } else if (item.status === 'succeeded') {
        note = 'Finished';
      } else {
        note = 'Queued';
      }

      html += '<div class="run-all-batch-row">';
      html += renderRunAllBatchIndicator(item);
      html += '<div>';
      html += '<div class="run-all-batch-name">' + escapeHtml(item.plugin_name || item.plugin_id) + '</div>';
      html += '<div class="run-all-batch-note">' + escapeHtml(note) + '</div>';
      html += '</div>';
      html += '<div class="run-all-batch-status">' + escapeHtml(runAllBatchStatusLabel(item.status)) + '</div>';
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="run-all-batch-footer">';
    html += batch.status === 'running'
      ? 'Batch in progress.'
      : 'Batch complete. This view will stay open until you close it.';
    html += '</div>';
    return html;
  }

  function syncRunAllBatchButton(pluginsStatus) {
    var runAllBtn = $('run-all-plugins-btn');
    if (!runAllBtn || !pluginsStatus || pluginsStatus.error) return;
    var enabledCount = Array.isArray(pluginsStatus.plugins)
      ? pluginsStatus.plugins.filter(function(item) { return item && item.enabled; }).length
      : 0;
    var isBusy = Boolean(pluginsStatus.scheduler && pluginsStatus.scheduler.running);
    runAllBtn.disabled = !authToken || isBusy || enabledCount === 0;
    runAllBtn.textContent = isBusy && activeRunAllBatch && activeRunAllBatch.status === 'running' ? 'Running...' : 'Run All';
  }

  function syncRunAllBatch(pluginsStatus) {
    if (!pluginsStatus || pluginsStatus.error) return;
    var batch = pluginsStatus.run_all_batch || null;
    if (batch && activeRunAllBatchId && batch.batch_id === activeRunAllBatchId) {
      activeRunAllBatch = batch;
    }
    if (!activeRunAllBatch && batch && !activeRunAllBatchId) {
      activeRunAllBatch = batch;
    }
    if (!runAllBatchModal || runAllBatchModal.getAttribute('aria-hidden') === 'true' || !runAllBatchContent) {
      return;
    }
    if (activeRunAllBatch) {
      runAllBatchContent.innerHTML = renderRunAllBatch(activeRunAllBatch);
    }
  }

  function dayLabel(day) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || 'Day ' + day;
  }

  function scheduleSummary(schedule) {
    if (!schedule || schedule.kind === 'manual') return 'Manual only';
    if (schedule.kind === 'daily') return 'Daily at ' + (schedule.time || '03:00');
    return 'Weekly on ' + dayLabel(schedule.day || 1) + ' at ' + (schedule.time || '03:00');
  }

  function renderTagPill(name, active, disabled) {
    return '<button type="button" class="tag-pill' + (active ? ' active' : '') + '" data-tag-pill="' + escapeHtml(name) + '"' + (disabled ? ' disabled' : '') + '>#' + escapeHtml(name) + '</button>';
  }

  function renderPluginConfigField(pluginId, field, value, disabled) {
    var html = '<div class="plugin-config-field">';
    html += '<label>' + escapeHtml(field.label) + '</label>';
    if (field.type === 'tag_list') {
      var activeTags = normalizeTagListValue(value);
      var activeNames = {};
      for (var a = 0; a < activeTags.length; a++) {
        activeNames[activeTags[a].name] = true;
      }

      // Merge with discovered tags from localStorage
      var discovered = [];
      try { discovered = JSON.parse(localStorage.getItem('discovered-tags-' + pluginId) || '[]'); } catch(e) {}
      var allPills = [];
      for (var a2 = 0; a2 < activeTags.length; a2++) {
        allPills.push({ name: activeTags[a2].name, active: true });
      }
      for (var d = 0; d < discovered.length; d++) {
        if (!activeNames[discovered[d]]) {
          allPills.push({ name: discovered[d], active: false });
        }
      }

      html = '<div class="plugin-config-field" data-tag-list-root="' + escapeHtml(field.key) + '">';
      html += '<label>' + escapeHtml(field.label) + '</label>';
      html += '<div class="plugin-tag-pills" data-tag-list="' + escapeHtml(field.key) + '">';
      if (allPills.length === 0) {
        html += '<span class="plugin-tag-empty">No tags yet \u2014 click Check for tags</span>';
      }
      for (var t = 0; t < allPills.length; t++) {
        html += renderTagPill(allPills[t].name, allPills[t].active, disabled);
      }
      html += '</div>';
      html += '<div class="tag-pill-actions">';
      html += '<button type="button" class="btn btn-muted" onclick="checkForTags(this)" data-tag-check' + (disabled ? ' disabled' : '') + '>Check for tags</button>';
      html += '</div>';
      html += '</div>';
      return html;
    }
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

  function renderRunItemDetails(item) {
    var changeType = item.change_type || 'rename_note';
    var html = '';
    if (changeType === 'merge_note_into_list') {
      html += '<div class="plugin-card-row"><span class="stat-label">Source title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.sourceTitle) || (item.before && item.before.sourceTitle) || (item.before && item.before.title) || 'Unknown') + '</span></div>';
      html += '<div class="plugin-card-row"><span class="stat-label">Destination title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.destinationTitle) || (item.after && item.after.destinationTitle) || 'Unknown') + '</span></div>';
      if (item.preview && item.preview.insertedListText) {
        html += '<div class="plugin-card-note"><strong>Inserted content</strong></div>';
        html += '<pre class="plugin-card-note" style="white-space:pre-wrap">' + escapeHtml(String(item.preview.insertedListText)) + '</pre>';
      }
      return html;
    }
    if (changeType === 'replace_managed_block') {
      html += '<div class="plugin-card-row"><span class="stat-label">Note title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.title) || (item.before && item.before.title) || 'Unknown') + '</span></div>';
      html += '<div class="plugin-card-row"><span class="stat-label">Block id</span><span class="stat-value">' + escapeHtml((item.after && item.after.blockId) || (item.before && item.before.blockId) || 'Unknown') + '</span></div>';
      if (item.preview && item.preview.renderedBlock) {
        html += '<div class="plugin-card-note"><strong>Rendered block</strong></div>';
        html += '<pre class="plugin-card-note" style="white-space:pre-wrap">' + escapeHtml(String(item.preview.renderedBlock)) + '</pre>';
      }
      return html;
    }

    html += '<div class="plugin-card-row"><span class="stat-label">Old title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.oldTitle) || (item.before && item.before.title) || 'Unknown') + '</span></div>';
    html += '<div class="plugin-card-row"><span class="stat-label">Proposed title</span><span class="stat-value">' + escapeHtml((item.preview && item.preview.proposedTitle) || (item.after && item.after.newTitle) || 'Unknown') + '</span></div>';
    return html;
  }

  function renderRunDetail(detail, canManagePlugins, isBusy) {
    if (!detail || !detail.run) return '';
    var run = detail.run;
    var items = detail.items || [];
    var logs = detail.logs || [];
    var html = '<div class="plugin-detail">';
    html += '<div class="plugin-detail-section">';
    html += '<div class="plugin-detail-header">';
    html += '<h3>Latest Run</h3>';
    html += '<span class="plugin-card-note">' + escapeHtml(run.run_id) + '</span>';
    html += '</div>';
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
    var hasPending = items.some(function(item) { return item.status === 'suggested' || item.status === 'approved'; });
    if (hasPending) {
      html += '<div class="plugin-card-actions">';
      html += '<button class="btn btn-muted" onclick="approveAllRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Approve all</button>';
      html += '<button class="btn btn-muted" onclick="rejectAllRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Reject all</button>';
      html += '<button class="btn btn-primary" onclick="applyApprovedRunItems(\\'' + run.run_id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Apply approved</button>';
      html += '</div>';
    }
    html += '<div class="plugin-detail-group-label">Changes</div>';
    if (items.length === 0) {
      html += '<div class="plugin-card-note">No proposed changes.</div>';
    } else {
      html += '<div class="plugin-run-items">';
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        html += '<div class="plugin-run-item">';
        html += '<div class="plugin-card-row"><span class="stat-label">Status</span><span class="stat-value">' + badge(item.status, item.status === 'failed' ? 'error' : item.status === 'applied' ? 'ok' : item.status === 'rejected' ? 'muted' : 'warn') + '</span></div>';
        html += renderRunItemDetails(item);
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
    if (logs.length > 0) {
      html += '<div class="plugin-detail-group-label">Activity</div>';
      html += '<div class="plugin-log-list">';
      for (var j = 0; j < logs.length; j++) {
        var entry = logs[j];
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
    var hasLocalPlugins = Boolean(t.plugins && t.plugins.some(function(item) { return item.source_kind === 'local'; }));

    html += '<div class="plugin-toolbar">';
    html += '<div class="plugin-toolbar-copy">';
    html += '<span class="plugin-toolbar-label">Automation Runtime</span>';
    html += '<span class="plugin-toolbar-value">' + (sched.phase === 'running'
      ? 'Running automation jobs'
      : hasLocalPlugins ? 'Built-in + local automations' : 'Built-in automations') + '</span>';
    html += '</div>';
    html += '<div class="plugin-toolbar-actions">';
    html += '<span class="plugin-auth-note">' + (canManagePlugins ? 'Signed in for automation controls' : 'Log in to run, configure, approve changes, and manage local automations') + '</span>';
    if (canManagePlugins) {
      html += '<span>' + badge('Signed in', 'ok') + '</span>';
      html += '<button class="action-link" onclick="logoutDashboard()">Sign out</button>';
    } else {
      html += '<button class="btn btn-muted" onclick="loginDashboard()">Log in</button>';
    }
    html += '</div>';
    html += '</div>';

    if (!t.plugins || t.plugins.length === 0) {
      html += '<div class="plugin-card-grid-empty">No automations registered.</div>';
    }

    if (t.plugins && t.plugins.length > 0) {
      html += '<div class="plugin-grid" id="plugin-grid">';
      for (var i = 0; i < t.plugins.length; i++) {
        var tr = t.plugins[i];
        var scheduleKind = getPluginScheduleKind(tr);
        var scheduleTime = getPluginScheduleTime(tr);
        var scheduleDay = getPluginScheduleDay(tr);
        var autoApply = getPluginAutoApply(tr);
        html += '<article class="plugin-card' + (tr.source_kind === 'local' ? ' plugin-card-local' : '') + '" data-plugin-card="' + escapeHtml(tr.id) + '">';
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
        html += '<span class="plugin-pill' + (tr.source_kind === 'local' ? ' plugin-pill-local' : '') + '">' + escapeHtml(tr.source_label || 'Built-in') + '</span>';
        html += '<span class="plugin-pill">' + escapeHtml(scheduleSummary({ kind: scheduleKind, time: scheduleTime, day: scheduleDay })) + '</span>';
        html += '<span class="plugin-pill">' + (autoApply ? 'Auto-apply on' : 'Preview first') + '</span>';
        html += '<span class="plugin-pill">' + tr.pending_approval_count + ' pending approvals</span>';
        if (tr.load_status && tr.load_status !== 'ready') {
          html += '<span class="plugin-pill">' + escapeHtml(tr.load_status) + '</span>';
        }
        html += '</div>';

        html += '<div class="plugin-card-section">';
        html += '<div class="plugin-card-row"><span class="stat-label">Source</span><span class="stat-value plugin-source">' + escapeHtml(tr.source_label || 'Built-in') + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Next run</span><span class="stat-value">' + formatTime(tr.next_run_at) + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Last run</span><span class="stat-value">' + (tr.last_run ? formatTime(tr.last_run.finished_at || tr.last_run.started_at) : 'Never') + '</span></div>';
        html += '<div class="plugin-card-row"><span class="stat-label">Last result</span><span class="stat-value">' + (tr.last_run ? badge(tr.last_run.status, tr.last_run.status === 'failed' ? 'error' : tr.last_run.status === 'awaiting_approval' ? 'warn' : 'ok') : badge('Never', 'muted')) + '</span></div>';
        if (tr.load_error) {
          html += '<div class="plugin-card-note plugin-card-warning">' + escapeHtml(tr.load_error) + '</div>';
        }
        html += '</div>';

        html += '<div class="plugin-card-section">';
        html += '<div class="plugin-config-grid">';
        html += '<div class="plugin-config-field"><label>Schedule</label><select data-schedule-kind onchange="syncScheduleFields(this)"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>';
        html += '<option value="manual"' + (scheduleKind === 'manual' ? ' selected' : '') + '>Manual</option>';
        html += '<option value="daily"' + (scheduleKind === 'daily' ? ' selected' : '') + '>Daily</option>';
        html += '<option value="weekly"' + (scheduleKind === 'weekly' ? ' selected' : '') + '>Weekly</option>';
        html += '</select></div>';
        html += '<div class="plugin-config-field"><label>Time</label><input type="time" data-schedule-time value="' + escapeHtml(scheduleTime) + '"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '></div>';
        html += '<div class="plugin-config-field" data-schedule-day-field' + (scheduleKind === 'weekly' ? '' : ' style="display:none"') + '><label>Weekly day</label><select data-schedule-day' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>';
        for (var day = 0; day < 7; day++) {
          html += '<option value="' + day + '"' + (scheduleDay === day ? ' selected' : '') + '>' + dayLabel(day) + '</option>';
        }
        html += '</select></div>';
        html += '<div class="plugin-config-field"><label>Auto-apply</label><input type="checkbox" data-auto-apply' + (autoApply ? ' checked' : '') + (!canManagePlugins || isBusy ? ' disabled' : '') + '></div>';
        for (var f = 0; f < (tr.config_schema || []).length; f++) {
          var field = tr.config_schema[f];
          var value = getPluginConfigValue(tr, field);
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
        if (tr.source_kind === 'local') {
          html += '<button class="btn btn-muted" onclick="editLocalPlugin(\\'' + tr.id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Edit code</button>';
          html += '<button class="action-link" onclick="deleteLocalPlugin(\\'' + tr.id + '\\')"' + (!canManagePlugins || isBusy ? ' disabled' : '') + '>Delete</button>';
        }
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
      const pluginEditing = isPluginConfigEditing();

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
          if (!pluginEditing) {
            $('plugins-content').innerHTML = renderPlugins(data.plugins);
          }
          syncRunAllBatchButton(data.plugins);
          syncRunAllBatch(data.plugins);
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

  window.triggerAllPlugins = async function() {
    const token = await getToken('run all automations');
    if (!token) return;
    try {
      const res = await fetch('/plugins/run-all', {
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
        alert(data.error || 'Failed to run automations');
        return;
      }
      activeRunAllBatchId = data.batch_id || (data.batch && data.batch.batch_id) || null;
      activeRunAllBatch = data.batch || null;
      window.openRunAllModal();
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.checkForTags = async function(button) {
    var root = button && button.closest ? button.closest('[data-tag-list-root]') : null;
    if (!root) return;
    var list = root.querySelector('[data-tag-list]');
    if (!list) return;
    var card = root.closest('[data-plugin-card]');
    if (!card) return;
    var pluginId = card.getAttribute('data-plugin-card');
    if (!pluginId) return;

    var token = await getToken('scan notes for tags');
    if (!token) return;

    button.disabled = true;
    button.textContent = 'Scanning\u2026';
    try {
      var res = await fetch('/plugins/tags', {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        refresh();
        return;
      }
      var data = await res.json();
      if (!res.ok || !Array.isArray(data.tags)) {
        alert(data.error || 'Failed to scan tags');
        return;
      }

      // Persist discovered tags to localStorage
      localStorage.setItem('discovered-tags-' + pluginId, JSON.stringify(data.tags));

      // Collect currently active tag names
      var activeTags = {};
      var oldPills = list.querySelectorAll('.tag-pill.active');
      for (var i = 0; i < oldPills.length; i++) {
        activeTags[oldPills[i].getAttribute('data-tag-pill')] = true;
      }

      // Replace all pills with the discovered set
      list.innerHTML = '';
      for (var j = 0; j < data.tags.length; j++) {
        var tagName = data.tags[j];
        var isActive = activeTags[tagName] || false;
        list.insertAdjacentHTML('beforeend', renderTagPill(tagName, isActive, false));
      }

      if (data.tags.length === 0) {
        list.innerHTML = '<span class="plugin-tag-empty">No tags found in your notes</span>';
      }

      button.textContent = data.tags.length > 0
        ? 'Found ' + data.tags.length + ' tag' + (data.tags.length === 1 ? '' : 's')
        : 'No tags in your notes';
      setTimeout(function() { button.textContent = 'Check for tags'; button.disabled = false; }, 2000);
    } catch (e) {
      alert('Error: ' + e.message);
      button.textContent = 'Check for tags';
      button.disabled = false;
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
      schedule_day: card.querySelector('[data-schedule-kind]').value === 'weekly'
        ? Number(card.querySelector('[data-schedule-day]').value)
        : null,
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

    var tagLists = card.querySelectorAll('[data-tag-list]');
    for (var j = 0; j < tagLists.length; j++) {
      var list = tagLists[j];
      var tagKey = list.getAttribute('data-tag-list');
      if (!tagKey) continue;
      body.config[tagKey] = readTagListValue(card, tagKey);
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
      clearPluginDraft(id);
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.syncScheduleFields = function(selectEl) {
    var card = selectEl && selectEl.closest ? selectEl.closest('[data-plugin-card]') : null;
    if (!card) return;
    var weeklyDayField = card.querySelector('[data-schedule-day-field]');
    if (!weeklyDayField) return;
    weeklyDayField.style.display = selectEl.value === 'weekly' ? '' : 'none';
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

  const pluginEditorModal = $('plugin-editor-modal');
  const pluginEditorTitle = $('plugin-editor-title');
  const pluginEditorCopy = $('plugin-editor-copy');
  const pluginEditorIdInput = $('plugin-editor-id');
  const pluginEditorSource = $('plugin-editor-source');
  const pluginEditorError = $('plugin-editor-error');
  const pluginEditorSaveBtn = $('plugin-editor-save-btn');
  const pluginEditorCancelBtn = $('plugin-editor-cancel-btn');
  const pluginEditorCloseBtn = $('plugin-editor-close-btn');
  const resetModal = $('reset-modal');
  const resetInput = $('reset-confirm-input');
  const resetConfirmBtn = $('reset-confirm-btn');
  const resetCancelBtn = $('reset-cancel-btn');
  const eraseResetBtn = $('erase-reset-btn');
  const runAllBatchModal = $('run-all-modal');
  const runAllBatchContent = $('run-all-batch-content');
  const runAllBatchCloseBtn = $('run-all-modal-close-btn');

  function setPluginEditorError(message) {
    if (!pluginEditorError) return;
    if (!message) {
      pluginEditorError.style.display = 'none';
      pluginEditorError.textContent = '';
      return;
    }
    pluginEditorError.style.display = 'block';
    pluginEditorError.textContent = message;
  }

  function openPluginEditor(mode, pluginId, source, loadError) {
    pluginEditorMode = mode;
    pluginEditorPluginId = pluginId || null;
    if (!pluginEditorModal || !pluginEditorTitle || !pluginEditorCopy || !pluginEditorIdInput || !pluginEditorSource) return;
    pluginEditorModal.classList.add('open');
    pluginEditorModal.setAttribute('aria-hidden', 'false');
    pluginEditorTitle.textContent = mode === 'edit' ? 'Edit Local Automation' : 'New Local Automation';
    pluginEditorCopy.textContent = mode === 'edit'
      ? 'Update the local plugin source. Saving recompiles and hot-reloads it immediately.'
      : 'Paste a TypeScript plugin module. It will be transpiled, validated, persisted on disk, and loaded immediately.';
    pluginEditorIdInput.value = pluginId || '';
    pluginEditorIdInput.disabled = mode === 'edit';
    pluginEditorSource.value = source || defaultLocalPluginSource();
    setPluginEditorError(loadError || '');
    if (pluginEditorSaveBtn) {
      pluginEditorSaveBtn.disabled = false;
      pluginEditorSaveBtn.textContent = mode === 'edit' ? 'Save changes' : 'Save automation';
    }
    if (pluginEditorCancelBtn) pluginEditorCancelBtn.disabled = false;
    if (pluginEditorCloseBtn) pluginEditorCloseBtn.disabled = false;
    pluginEditorSource.focus();
  }

  window.openRunAllModal = function() {
    if (!runAllBatchModal || !runAllBatchContent) return;
    runAllBatchModal.classList.add('open');
    runAllBatchModal.setAttribute('aria-hidden', 'false');
    runAllBatchContent.innerHTML = renderRunAllBatch(activeRunAllBatch);
    if (runAllBatchCloseBtn) runAllBatchCloseBtn.disabled = false;
  };

  window.closeRunAllModal = function() {
    if (!runAllBatchModal) return;
    runAllBatchModal.classList.remove('open');
    runAllBatchModal.setAttribute('aria-hidden', 'true');
  };

  window.openCreatePluginDialog = function() {
    openPluginEditor('create', '', defaultLocalPluginSource(), '');
  };

  window.closePluginEditor = function() {
    pluginEditorMode = 'create';
    pluginEditorPluginId = null;
    if (!pluginEditorModal || !pluginEditorIdInput || !pluginEditorSource) return;
    pluginEditorModal.classList.remove('open');
    pluginEditorModal.setAttribute('aria-hidden', 'true');
    pluginEditorIdInput.value = '';
    pluginEditorIdInput.disabled = false;
    pluginEditorSource.value = '';
    setPluginEditorError('');
    if (pluginEditorSaveBtn) pluginEditorSaveBtn.textContent = 'Save automation';
  };

  window.editLocalPlugin = async function(pluginId) {
    const token = await getToken('edit local automation');
    if (!token) return;
    try {
      const res = await fetch('/plugins/local/' + pluginId + '/source', {
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
        alert(data.error || 'Failed to load plugin source');
        return;
      }
      openPluginEditor('edit', pluginId, data.source || '', data.loadError || '');
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  window.saveLocalPlugin = async function() {
    const token = await getToken(pluginEditorMode === 'edit' ? 'save local automation' : 'create local automation');
    if (!token) return;
    if (!pluginEditorIdInput || !pluginEditorSource || !pluginEditorSaveBtn || !pluginEditorCancelBtn || !pluginEditorCloseBtn) return;

    var pluginId = pluginEditorIdInput.value.trim();
    if (!pluginId) {
      setPluginEditorError('Plugin ID is required.');
      return;
    }

    var source = pluginEditorSource.value;
    if (source.indexOf('__PLUGIN_ID__') !== -1) {
      source = source.replace(/__PLUGIN_ID__/g, pluginId);
    }
    if (source.indexOf('__PLUGIN_NAME__') !== -1) {
      source = source.replace(/__PLUGIN_NAME__/g, pluginId.replace(/[-_]+/g, ' '));
    }

    setPluginEditorError('');
    pluginEditorSaveBtn.disabled = true;
    pluginEditorCancelBtn.disabled = true;
    pluginEditorCloseBtn.disabled = true;
    pluginEditorSaveBtn.textContent = pluginEditorMode === 'edit' ? 'Saving...' : 'Creating...';

    try {
      const isEdit = pluginEditorMode === 'edit';
      const res = await fetch(isEdit ? '/plugins/local/' + pluginId + '/source' : '/plugins/local', {
        method: isEdit ? 'PUT' : 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(isEdit ? { source: source } : { plugin_id: pluginId, source: source }),
      });
      if (res.status === 401) {
        clearAuthToken();
        alert('Session expired, please try again');
        window.closePluginEditor();
        refresh();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setPluginEditorError(data.error || 'Failed to save automation');
        return;
      }
      window.closePluginEditor();
      refresh();
    } catch (e) {
      setPluginEditorError('Error: ' + e.message);
    } finally {
      if (pluginEditorSaveBtn) {
        pluginEditorSaveBtn.disabled = false;
        pluginEditorSaveBtn.textContent = pluginEditorMode === 'edit' ? 'Save changes' : 'Save automation';
      }
      if (pluginEditorCancelBtn) pluginEditorCancelBtn.disabled = false;
      if (pluginEditorCloseBtn) pluginEditorCloseBtn.disabled = false;
    }
  };

  window.deleteLocalPlugin = async function(pluginId) {
    const token = await getToken('delete local automation');
    if (!token) return;
    if (!window.confirm('Delete local automation "' + pluginId + '"? Past run history will be kept.')) {
      return;
    }

    try {
      const res = await fetch('/plugins/local/' + pluginId, {
        method: 'DELETE',
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
        alert(data.error || 'Failed to delete local automation');
        return;
      }
      refresh();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

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

  if (pluginEditorModal) {
    pluginEditorModal.addEventListener('click', (event) => {
      if (event.target === pluginEditorModal) {
        window.closePluginEditor();
      }
    });
  }

  if (runAllBatchModal) {
    runAllBatchModal.addEventListener('click', (event) => {
      if (event.target === runAllBatchModal) {
        window.closeRunAllModal();
      }
    });
  }

  document.addEventListener('input', function(event) {
    capturePluginDraft(event.target);
  }, true);

  document.addEventListener('change', function(event) {
    capturePluginDraft(event.target);
  }, true);

  document.addEventListener('click', function(event) {
    var target = event.target;
    if (target && target.hasAttribute && target.hasAttribute('data-tag-pill')) {
      capturePluginDraft(target);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && resetModal && resetModal.classList.contains('open')) {
      window.closeResetDialog();
      return;
    }
    if (event.key === 'Escape' && runAllBatchModal && runAllBatchModal.classList.contains('open')) {
      window.closeRunAllModal();
      return;
    }
    if (event.key === 'Escape' && pluginEditorModal && pluginEditorModal.classList.contains('open')) {
      window.closePluginEditor();
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
