// Cross-editor judge: runs scenarios from markdown-spec/cases/ against
// FUTO Notes's editor and Obsidian's, then diffs the captured states.
//
// Modes (subcommand as first non-flag arg):
//
//   tsx factory/judge/run.ts                      # one-shot: boot, run, teardown
//   tsx factory/judge/run.ts daemon               # keep Obsidian + chromium up; listen on socket
//   tsx factory/judge/run.ts run [--filter ..]    # client: ask daemon to run, stream results
//   tsx factory/judge/run.ts down                 # client: tell daemon to shut down
//   tsx factory/judge/run.ts watch                # client: re-run on save of editor source files
//
// All client commands talk to the daemon over factory/captures/daemon.sock.

import { spawn, ChildProcess } from 'child_process';
import { chromium, Browser, Page } from 'playwright';
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  rmSync,
  unlinkSync,
} from 'fs';
import * as net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadSpecCases, getCasesDir } from '../../markdown-spec/loader.ts';
import type { SpecCase, CursorMove } from '../../markdown-spec/schema.ts';
import { diffStates, summarize, type ScenarioReport } from './diff.ts';
import { runLayoutInvariants } from './layoutInvariants.ts';
import {
  injectNeutralTheme,
  captureEditorScreenshot,
  diffScreenshots,
  VISUAL_SCENARIO_NAMES,
  VISUAL_DIFF_TOLERANCE,
  type VisualDiffResult,
} from './visualDiff.ts';
import { writeVisualReport } from './visualReport.ts';
import type { DriverEvent, DriverState } from '../driver/protocol.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const VAULT_DIR = path.join(REPO, 'factory/captures/obsidian-vault');
const OBSIDIAN_CDP_PORT = 9876;
const OBSIDIAN_CONFIG_DIR = path.join(
  process.env.HOME || '',
  '.var/app/md.obsidian.Obsidian/config/obsidian',
);
const FACTORY_VAULT_ID = 'fac701ffac701ff0';
const DEV_URL = 'http://localhost:5173';
const REPORT_OUT = path.join(REPO, 'factory/captures/last-run.json');
const SOCKET_PATH = path.join(REPO, 'factory/captures/daemon.sock');

// ---------------------------------------------------------------------------
// Argv helpers
// ---------------------------------------------------------------------------

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface RunOptions {
  filter?: string;
  max?: number;
  noMoves?: boolean;
  reload?: boolean; // re-load pages before running (watch mode)
  visual?: boolean; // capture screenshots + run pixel diff (slow)
  visualOnly?: boolean; // restrict to the curated visual scenario set
}

function parseRunOptions(argv = process.argv): RunOptions {
  return {
    filter: argv.includes('--filter') ? argv[argv.indexOf('--filter') + 1] : undefined,
    max: argv.includes('--max') ? parseInt(argv[argv.indexOf('--max') + 1], 10) : undefined,
    noMoves: argv.includes('--no-moves'),
    reload: argv.includes('--reload'),
    visual: argv.includes('--visual') || argv.includes('--visual-only'),
    visualOnly: argv.includes('--visual-only'),
  };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main() {
  const sub = process.argv[2];
  switch (sub) {
    case 'daemon':
      return runDaemon();
    case 'run':
      return clientRun();
    case 'down':
      return clientDown();
    case 'watch':
      return clientWatch();
    default:
      return runOneshot();
  }
}

// ---------------------------------------------------------------------------
// Environment lifecycle
// ---------------------------------------------------------------------------

interface Env {
  page: Page;
  obsidianPage: Page | null;
  browser: Browser;
  cleanup: () => Promise<void>;
}

async function bootEnv({
  skipObsidian,
  headed,
}: {
  skipObsidian: boolean;
  headed: boolean;
}): Promise<Env> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const cleanup = async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {}
    }
  };

  // 1. Dev server
  const devAlreadyUp = await tryFetch(DEV_URL)
    .then(() => true)
    .catch(() => false);
  let devProc: ChildProcess | null = null;
  if (!devAlreadyUp) {
    console.log(`[boot] starting pnpm run dev`);
    devProc = spawn('pnpm', ['run', 'dev'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    devProc.stdout?.on('data', (d) => process.stdout.write(`[dev] ${d}`));
    devProc.stderr?.on('data', (d) => process.stderr.write(`[dev!] ${d}`));
    cleanups.push(() => {
      devProc?.kill('SIGINT');
    });
    await waitForUrl(DEV_URL, 30_000);
  } else {
    console.log(`[boot] reusing dev server on ${DEV_URL}`);
  }

  // 2. Obsidian
  let obsidianPage: Page | null = null;
  if (!skipObsidian) {
    setupVault();
    const restoreRegistry = prepareObsidianRegistry();
    cleanups.push(restoreRegistry);

    spawn('flatpak', ['kill', 'md.obsidian.Obsidian'], { stdio: 'ignore' }).on('close', () => {});
    await delay(800);

    console.log(`[boot] launching flatpak Obsidian (CDP :${OBSIDIAN_CDP_PORT})`);
    const obsidianProc = spawn(
      'flatpak',
      ['run', 'md.obsidian.Obsidian', `--remote-debugging-port=${OBSIDIAN_CDP_PORT}`, VAULT_DIR],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
    );
    obsidianProc.stdout?.on('data', (d) => process.stdout.write(`[ob] ${d}`));
    obsidianProc.stderr?.on('data', (d) => process.stderr.write(`[ob!] ${d}`));
    cleanups.push(async () => {
      await new Promise<void>((r) => {
        const p = spawn('flatpak', ['kill', 'md.obsidian.Obsidian'], { stdio: 'ignore' });
        p.on('close', () => r());
      });
    });

    obsidianPage = await connectObsidian({ vaultPath: VAULT_DIR, timeoutMs: 60_000 });
    console.log(`[boot] obsidian driver ready (vault ${path.basename(VAULT_DIR)})`);
  }

  // 3. Browser + futo-notes page
  const browser: Browser = await chromium.launch({ headless: !headed });
  cleanups.push(() => browser.close());
  const page: Page = await browser.newPage();
  await openFutoNotesPage(page);
  console.log(`[boot] futo-notes driver ready`);

  return { page, obsidianPage, browser, cleanup };
}

async function openFutoNotesPage(page: Page): Promise<void> {
  await page.goto(`${DEV_URL}/#/note/new`);
  await page.waitForSelector('.cm-editor', { timeout: 15_000 });
  await page.waitForFunction(() => !!(window as any).__driver, null, { timeout: 10_000 });
  await page.evaluate(() => {
    (window as any).__name = (fn: any) => fn;
  });
}

// ---------------------------------------------------------------------------
// Scenario loop (streaming)
// ---------------------------------------------------------------------------

type ProgressEvent =
  | { type: 'started'; total: number; reloaded?: boolean }
  | {
      type: 'progress';
      index: number;
      total: number;
      name: string;
      divergences: number;
      firstDiv?: string;
      error?: string;
    }
  | { type: 'summary'; summary: ReturnType<typeof summarize>; reportPath: string }
  | { type: 'log'; message: string };

async function runOneRound(
  env: Env,
  opts: RunOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ summary: ReturnType<typeof summarize>; reports: ScenarioReport[] }> {
  if (opts.reload) {
    onEvent({ type: 'log', message: 'reloading futo-notes page' });
    await openFutoNotesPage(env.page);
  }

  let cases = loadAndFilterCases({
    max: opts.max ?? Number.MAX_SAFE_INTEGER,
    filter: opts.filter,
    noMoves: opts.noMoves,
  });
  if (opts.visualOnly) {
    cases = cases.filter((c) => VISUAL_SCENARIO_NAMES.has(c.name));
  }

  // Inject the neutral theme on both pages once per round so SF and OB
  // render the same source with the same chrome.
  if (opts.visual) {
    try {
      await injectNeutralTheme(env.page);
    } catch {}
    if (env.obsidianPage) {
      try {
        await injectNeutralTheme(env.obsidianPage);
      } catch {}
    }
  }

  onEvent({ type: 'started', total: cases.length, reloaded: opts.reload });

  const reports: ScenarioReport[] = [];
  const visualResults: VisualDiffResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const events = scenarioToEvents(c);
      const sf = await runOnEditor(env.page, c.markdown, events);
      let ob: DriverState | null = null;
      if (env.obsidianPage) ob = await runOnEditor(env.obsidianPage, c.markdown, events, true);
      const divergences = ob ? diffStates(sf, ob) : [];
      // Layout invariants run on the SF page only — they're absolute
      // UX guarantees, not parity checks. Append any violations as
      // additional divergences so the existing summary/streaming UI
      // surfaces them without changes.
      const layoutViolations = await runLayoutInvariants(env.page);
      for (const v of layoutViolations) {
        divergences.push({
          kind: 'layout-violation',
          detail: v.invariant + ': ' + v.detail,
          data: v,
        });
      }
      // Phase-1 visual oracle: pixel diff between SF and OB
      // screenshots. Runs only when --visual is set; saves PNGs and
      // appends a `visual-divergence` only when drift exceeds tolerance.
      if (opts.visual && ob && env.obsidianPage) {
        const sfPath = await captureEditorScreenshot(env.page, c.name, 'sf');
        const obPath = await captureEditorScreenshot(env.obsidianPage, c.name, 'ob');
        if (sfPath && obPath) {
          const vr = diffScreenshots(c.name, sfPath, obPath);
          if (vr) {
            visualResults.push(vr);
            if (vr.diffRatio > VISUAL_DIFF_TOLERANCE) {
              divergences.push({
                kind: 'visual-divergence',
                detail: `pixel drift ${(vr.diffRatio * 100).toFixed(2)}% (${vr.diffPixels} px) — diff at ${path.relative(REPO, vr.diffPath)}`,
                data: vr,
              });
            }
          }
        }
      }
      const report: ScenarioReport = ob
        ? {
            name: c.name,
            complexity: c.complexity,
            satisfaction: 0,
            divergences,
            futoNotes: sf,
            obsidian: ob,
          }
        : { name: c.name, complexity: c.complexity, satisfaction: 1, divergences, futoNotes: sf };
      report.satisfaction = report.divergences.length === 0 ? 1 : 0;
      reports.push(report);
      onEvent({
        type: 'progress',
        index: i + 1,
        total: cases.length,
        name: c.name,
        divergences: report.divergences.length,
        firstDiv: report.divergences[0]?.detail,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      reports.push({
        name: c.name,
        complexity: c.complexity,
        satisfaction: 0,
        divergences: [],
        error,
      });
      onEvent({
        type: 'progress',
        index: i + 1,
        total: cases.length,
        name: c.name,
        divergences: 0,
        error,
      });
    }
  }

  const summary = summarize(reports);
  mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
  writeFileSync(REPORT_OUT, JSON.stringify({ summary, reports }, null, 2));

  if (opts.visual && visualResults.length > 0) {
    const reportPath = writeVisualReport(visualResults);
    onEvent({ type: 'log', message: `visual report: ${path.relative(REPO, reportPath)}` });
  }

  onEvent({ type: 'summary', summary, reportPath: REPORT_OUT });

  return { summary, reports };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runOneshot(): Promise<never> {
  const opts = parseRunOptions();
  const skipObsidian = flag('no-obsidian');
  const headed = flag('headed');

  let exitCode = 0;
  let env: Env | null = null;
  try {
    env = await bootEnv({ skipObsidian, headed });
    const { summary } = await runOneRound(env, opts, prettyPrintEvent);
    exitCode = summary.satisfaction === 1 ? 0 : 1;
  } catch (err) {
    console.error(err);
    exitCode = 2;
  } finally {
    if (env) await env.cleanup();
  }
  process.exit(exitCode);
}

async function runDaemon(): Promise<void> {
  const skipObsidian = flag('no-obsidian');
  const headed = flag('headed');

  console.log(`[daemon] booting (Obsidian ${skipObsidian ? 'OFF' : 'ON'}, headed ${headed})`);
  const env = await bootEnv({ skipObsidian, headed });
  console.log(`[daemon] ready — listening on ${SOCKET_PATH}`);

  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
  }

  let busy = false;

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.cmd === 'shutdown') {
          send(socket, { type: 'log', message: 'shutting down' });
          socket.end();
          server.close();
          await env.cleanup();
          process.exit(0);
        } else if (msg.cmd === 'run') {
          if (busy) {
            send(socket, { type: 'log', message: 'daemon busy — try again' });
            socket.end();
            return;
          }
          busy = true;
          try {
            await runOneRound(env, msg.opts ?? {}, (ev) => send(socket, ev));
          } catch (e) {
            send(socket, { type: 'log', message: `error: ${e instanceof Error ? e.message : e}` });
          } finally {
            busy = false;
            socket.end();
          }
        }
      }
    });
    socket.on('error', () => {});
  });
  server.listen(SOCKET_PATH);

  const shutdown = async () => {
    console.log(`[daemon] shutting down`);
    server.close();
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
    await env.cleanup();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function send(socket: net.Socket, ev: ProgressEvent): void {
  try {
    socket.write(JSON.stringify(ev) + '\n');
  } catch {}
}

async function clientRun(): Promise<never> {
  if (!existsSync(SOCKET_PATH)) {
    console.error(`[client] no daemon at ${SOCKET_PATH} — start with 'just factory-up'`);
    process.exit(2);
  }
  const opts = parseRunOptions();
  const exitCode = await sendRun(opts, prettyPrintEvent);
  process.exit(exitCode);
}

async function clientDown(): Promise<never> {
  if (!existsSync(SOCKET_PATH)) {
    console.log(`[client] no daemon running`);
    process.exit(0);
  }
  await new Promise<void>((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
    });
    sock.on('end', () => resolve());
    sock.on('error', () => resolve());
    sock.on('close', () => resolve());
  });
  console.log(`[client] daemon stopped`);
  process.exit(0);
}

async function clientWatch(): Promise<never> {
  if (!existsSync(SOCKET_PATH)) {
    console.error(`[client] no daemon at ${SOCKET_PATH} — start with 'just factory-up'`);
    process.exit(2);
  }
  const opts = parseRunOptions();
  const markdownStylePaths = readdirSync(path.join(REPO, 'src/styles'))
    .filter((name) => name.startsWith('markdown') && name.endsWith('.css'))
    .map((name) => path.join(REPO, 'src/styles', name));
  const watchPaths = [
    path.join(REPO, 'src/features/editor/liveMarkdownTransform.ts'),
    path.join(REPO, 'src/features/editor/live-preview'),
    path.join(REPO, 'src/features/editor/MarkdownEditor.svelte'),
    ...markdownStylePaths,
    path.join(REPO, 'factory/driver/futoNotes.ts'),
    path.join(REPO, 'factory/driver/semanticKind.ts'),
    path.join(REPO, 'factory/judge/diff.ts'),
  ];
  console.log(`[watch] watching ${watchPaths.length} files (Ctrl-C to stop)`);

  const chokidarMod: any = await import('chokidar');
  const chokidar = chokidarMod.default ?? chokidarMod;
  const watcher = chokidar.watch(watchPaths, { ignoreInitial: false });

  let running = false;
  let pending = false;
  const trigger = async (reason: string) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
      console.log(`\n[watch] ${reason} — running`);
      try {
        await sendRun({ ...opts, reload: true }, prettyPrintEvent);
      } catch (e) {
        console.error(`[watch] error: ${e instanceof Error ? e.message : e}`);
      }
    } while (pending);
    running = false;
  };

  watcher.on('ready', () => trigger('initial run'));
  watcher.on('change', (p: string) => trigger(`change ${path.relative(REPO, p)}`));

  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
  // Keep alive
  await new Promise(() => {});
  process.exit(0);
}

async function sendRun(opts: RunOptions, onEvent: (e: ProgressEvent) => void): Promise<number> {
  return new Promise<number>((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    let lastSummary: ReturnType<typeof summarize> | null = null;
    let buf = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify({ cmd: 'run', opts }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as ProgressEvent;
          if (ev.type === 'summary') lastSummary = ev.summary;
          onEvent(ev);
        } catch {}
      }
    });
    sock.on('end', () => resolve(lastSummary && lastSummary.satisfaction === 1 ? 0 : 1));
    sock.on('error', (err) => {
      console.error(`[client] ${err.message}`);
      resolve(2);
    });
  });
}

function prettyPrintEvent(ev: ProgressEvent): void {
  switch (ev.type) {
    case 'started':
      console.log(`[run] ${ev.total} scenarios${ev.reloaded ? ' (reloaded)' : ''}`);
      break;
    case 'progress': {
      const tag = ev.error
        ? `ERR ${ev.error}`
        : ev.divergences === 0
          ? 'OK'
          : `${ev.divergences} div`;
      const detail = ev.firstDiv && ev.divergences > 0 ? `  — ${ev.firstDiv}` : '';
      const i = `${ev.index}/${ev.total}`.padStart(7);
      console.log(`[${i}] ${ev.name.padEnd(40)} ${tag}${detail}`);
      break;
    }
    case 'summary': {
      const s = ev.summary;
      console.log(
        `\n[summary] ${s.passed}/${s.total} passed (${(s.satisfaction * 100).toFixed(1)}%)`,
      );
      console.log(`          buckets: ${JSON.stringify(s.buckets)}`);
      console.log(`          report:  ${ev.reportPath}`);
      break;
    }
    case 'log':
      console.log(`[log] ${ev.message}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers (unchanged from prior version)
// ---------------------------------------------------------------------------

function loadAndFilterCases({
  max,
  filter,
  noMoves,
}: {
  max: number;
  filter?: string;
  noMoves?: boolean;
}): SpecCase[] {
  const all = loadSpecCases(getCasesDir());
  let usable = all.filter(
    (c) => !!c.markdown && (c.cursor !== undefined || c.start_cursor !== undefined),
  );
  if (noMoves) usable = usable.filter((c) => !c.moves || c.moves.length === 0);
  const filtered = filter
    ? usable.filter((c) => c.name.includes(filter) || (c as any).markdown?.includes(filter))
    : usable;
  return filtered.slice(0, max);
}

function scenarioToEvents(c: SpecCase): DriverEvent[] {
  const evs: DriverEvent[] = [];
  const cursor = c.start_cursor ?? c.cursor;
  if (cursor) {
    evs.push({ type: 'place_cursor', line: cursor.line, ch: cursor.ch });
  } else if (cursor === null) {
    evs.push({ type: 'blur' });
  }
  if (c.moves) {
    for (const m of c.moves) evs.push({ type: 'key', key: m as CursorMove });
  }
  return evs;
}

async function runOnEditor(
  page: Page,
  markdown: string,
  events: DriverEvent[],
  isObsidian = false,
): Promise<DriverState> {
  await page.evaluate(
    async ({ markdown }) => {
      const w = window as any;
      if (!w.__driver) throw new Error('window.__driver missing');
      await w.__driver.setDoc(markdown);
    },
    { markdown },
  );

  const wantsFocus = events.some(
    (e) => e.type === 'place_cursor' || e.type === 'focus' || e.type === 'type' || e.type === 'key',
  );
  if (wantsFocus && isObsidian) {
    // Real OS-level click so document.activeElement actually lands on
    // contentDOM. Obsidian's live-preview reveal logic checks that —
    // programmatic cm.focus() doesn't satisfy it. FUTO Notes's reveal
    // is selection-driven and doesn't need the click; skipping it
    // avoids the click landing on a widget at (4,4) which can move
    // the caret off the requested position.
    await page
      .locator('.cm-content[data-factory-target="true"]')
      .click({ position: { x: 4, y: 4 }, force: true });
  } else if (wantsFocus) {
    // FUTO Notes just needs the editor to know it's focused.
    await page.evaluate(async () => {
      await (window as any).__driver.dispatch([{ type: 'focus' }]);
    });
  }

  // Cursor moves and arrow-key events go through Playwright's keyboard
  // so CM6 receives real, trusted KeyboardEvents — Obsidian's reveal
  // logic keys off them. FUTO Notes's reveal is selection-state-driven
  // and accepts a programmatic `place_cursor` dispatch; using that
  // here avoids surprises when SF redirects the caret out of
  // list-marker source ranges (clicking at col 0 of `- foo` lands at
  // col 2 — a real UX feature that breaks the keystroke model's
  // "Home + ArrowRight × ch" assumption).
  for (const ev of events) {
    if (ev.type === 'place_cursor') {
      if (isObsidian) {
        await page.keyboard.press('Control+Home');
        for (let i = 0; i < ev.line; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Home');
        for (let i = 0; i < ev.ch; i++) await page.keyboard.press('ArrowRight');
      } else {
        await page.evaluate(
          async ({ line, ch }) => {
            await (window as any).__driver.dispatch([{ type: 'place_cursor', line, ch }]);
          },
          { line: ev.line, ch: ev.ch },
        );
      }
    } else if (ev.type === 'key') {
      await page.keyboard.press(ev.key);
    } else if (ev.type === 'type') {
      await page.keyboard.type(ev.text);
    } else if (ev.type === 'set_doc' || ev.type === 'blur' || ev.type === 'focus') {
      // Doc/focus changes still go through the in-page driver — these
      // don't depend on real input events.
      await page.evaluate(
        async ({ ev }) => {
          await (window as any).__driver.dispatch([ev]);
        },
        { ev },
      );
    }
  }

  return await page.evaluate(async () => {
    return await (window as any).__driver.state();
  });
}

async function connectObsidian({
  vaultPath,
  timeoutMs,
}: {
  vaultPath: string;
  timeoutMs: number;
}): Promise<Page> {
  const cdpUrl = `http://127.0.0.1:${OBSIDIAN_CDP_PORT}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await tryFetch(`${cdpUrl}/json/version`);
      break;
    } catch {}
    await delay(400);
  }
  if (Date.now() - start >= timeoutMs) throw new Error('timeout waiting for Obsidian CDP');

  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  let page: Page | null = null;
  const vaultName = path.basename(vaultPath);
  while (Date.now() - start < timeoutMs) {
    for (const p of ctx.pages()) {
      const url = p.url();
      if (!url.startsWith('app://')) continue;
      const title = await p.title().catch(() => '');
      if (/Obsidian/i.test(title)) {
        const ready = await p
          .evaluate(() => !!(window as any).app && !!(window as any).app.workspace)
          .catch(() => false);
        if (ready) {
          page = p;
          break;
        }
      }
    }
    if (page) break;
    await delay(400);
  }
  if (!page) throw new Error('no Obsidian renderer page found');

  const activeVault = await page.evaluate(() => {
    const a = (window as any).app;
    return a && a.vault && a.vault.adapter && a.vault.adapter.basePath;
  });
  if (typeof activeVault !== 'string' || !activeVault.endsWith(vaultName)) {
    throw new Error(
      `Obsidian opened wrong vault: got ${activeVault}, expected basename ${vaultName}`,
    );
  }

  await installObsidianDriver(page);
  return page;
}

async function installObsidianDriver(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__name = (fn: any) => fn;
  });
  await page.evaluate(async () => {
    const w = window as any;
    if (w.__driver) return;
    const SCRATCH = '__factory_scratch.md';

    // Cache the scratch leaf across driver calls so setDoc and state
    // always operate on the same CM instance. Without caching, multi-
    // leaf vaults can return a different leaf between calls — e.g. if
    // a previous run left a stale leaf on disk content while the active
    // leaf has the freshly-dispatched content.
    let cachedLeaf: any = null;
    const ensureScratchCM = async () => {
      const file =
        w.app.vault.getAbstractFileByPath(SCRATCH) ?? (await w.app.vault.create(SCRATCH, ''));
      // Validate the cached leaf still exists, has its view, and is
      // pointing at the scratch file. Otherwise rediscover.
      const leafIsLive = (l: any) =>
        l &&
        l.view &&
        l.view.file &&
        l.view.file.path === SCRATCH &&
        document.body.contains(l.view.contentEl);
      if (!leafIsLive(cachedLeaf)) {
        cachedLeaf = null;
        w.app.workspace.iterateAllLeaves((l: any) => {
          if (!cachedLeaf && leafIsLive(l)) cachedLeaf = l;
        });
        if (!cachedLeaf) {
          cachedLeaf = w.app.workspace.getLeaf(false);
          await cachedLeaf.openFile(file, { active: true });
        }
        const vs = cachedLeaf.getViewState && cachedLeaf.getViewState();
        if (!vs || vs.type !== 'markdown' || vs?.state?.source !== false) {
          await cachedLeaf.setViewState({
            type: 'markdown',
            state: { file: SCRATCH, mode: 'source', source: false },
          });
        }
      }
      // Bring the scratch leaf to the front so its contentDOM is the
      // visible one. setActiveLeaf alone leaves stacked tabs in their
      // current z-order; revealLeaf forces it to the top.
      if (typeof w.app.workspace.revealLeaf === 'function') {
        await w.app.workspace.revealLeaf(cachedLeaf);
      }
      w.app.workspace.setActiveLeaf(cachedLeaf, { focus: false });
      const cm = cachedLeaf.view && cachedLeaf.view.editor && cachedLeaf.view.editor.cm;
      if (!cm) throw new Error('no cm');
      // Tag the content DOM so the runner can click *this* editor and
      // not a sibling .cm-content (Obsidian has multiple — sidebars,
      // other open tabs, etc.).
      try {
        for (const el of document.querySelectorAll('.cm-content[data-factory-target]')) {
          el.removeAttribute('data-factory-target');
        }
        cm.contentDOM.setAttribute('data-factory-target', 'true');
      } catch {}
      return cm;
    };
    const tick = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const posToPos = (cm: any, pos: number) => {
      const line = cm.state.doc.lineAt(pos);
      return { line: line.number - 1, ch: pos - line.from, pos };
    };
    const lineChToPos = (cm: any, line: number, ch: number) => {
      const doc = cm.state.doc;
      const t = Math.min(Math.max(line, 0), doc.lines - 1);
      const li = doc.line(t + 1);
      return li.from + Math.min(Math.max(ch, 0), li.length);
    };
    const isWidget = (el: Element) => {
      if (el.classList.contains('cm-widgetBuffer')) return false;
      return [
        'cm-md-hr-widget',
        'cm-md-image-wrapper',
        'cm-md-image-widget',
        'cm-md-table-wrapper',
        'cm-md-table-rendered',
        'cm-md-task-checkbox-wrapper',
        'sf-table',
        'internal-embed',
        'cm-embed-block',
        'image-embed',
      ].some((c) => el.classList.contains(c));
    };
    // Returns every semantic kind an element belongs to. Obsidian
    // commonly carries multiple kinds on one span (e.g. `cm-em cm-strong`
    // for bold+italic); SF emits separate elements per concept. Returning
    // an array lets the diff bucket each element under each kind it
    // belongs to.
    const classToKinds = (classes: string[]): string[] => {
      const set = new Set(classes);
      const out = new Set<string>();
      if (set.has('cm-md-quote-marker-hidden')) out.add('quote-marker');
      if (set.has('cm-blockquote-border')) out.add('quote-marker');
      if (set.has('cm-formatting')) {
        if (set.has('cm-formatting-strong')) out.add('bold-marker');
        if (set.has('cm-formatting-em')) out.add('italic-marker');
        if (set.has('cm-formatting-strikethrough')) out.add('strikethrough-marker');
        if (set.has('cm-formatting-header')) out.add('heading-marker');
        if (set.has('cm-formatting-link') && !set.has('cm-hmd-barelink')) out.add('link-marker');
        if (set.has('cm-formatting-link-string')) out.add('link-url');
        if (set.has('cm-formatting-quote')) out.add('quote-marker');
        if (set.has('cm-formatting-code')) out.add('code-fence-marker');
        if (set.has('cm-formatting-list')) out.add('list-marker');
        if (set.has('cm-formatting-hashtag')) out.add('tag');
      }
      for (let n = 1; n <= 6; n++) if (set.has(`cm-md-h${n}-marker`)) out.add('heading-marker');
      if (set.has('cm-md-strong-marker')) out.add('bold-marker');
      if (set.has('cm-md-emphasis-marker')) out.add('italic-marker');
      if (set.has('cm-md-strikethrough-marker')) out.add('strikethrough-marker');
      if (set.has('cm-md-code-marker')) out.add('code-fence-marker');
      if (set.has('cm-md-link-marker')) out.add('link-marker');
      if (out.size === 0 && set.has('cm-md-inline-marker')) out.add('italic-marker');
      let leveledHeading = false;
      for (let n = 1; n <= 6; n++) {
        if (set.has(`cm-md-h${n}`) || set.has(`cm-header-${n}`)) {
          out.add(`heading-text-${n}`);
          leveledHeading = true;
        }
      }
      if (!leveledHeading && (set.has('cm-md-h') || set.has('cm-header')))
        out.add('heading-text-1');
      if (set.has('cm-md-strong') || set.has('cm-strong')) out.add('bold-text');
      if (set.has('cm-md-emphasis') || set.has('cm-em')) out.add('italic-text');
      if (set.has('cm-md-strikethrough') || set.has('cm-strikethrough'))
        out.add('strikethrough-text');
      if (
        [
          'cm-md-code-block',
          'cm-md-code-block-first',
          'cm-md-code-block-middle',
          'cm-md-code-block-last',
          'cm-md-code-block-single',
        ].some((c) => set.has(c))
      )
        out.add('code-block');
      const isCodeMarker = set.has('cm-md-code-marker') || set.has('cm-formatting-code');
      if (!isCodeMarker && (set.has('cm-md-code') || set.has('cm-inline-code')))
        out.add('code-inline');
      const isWikilink = set.has('cm-md-wikilink') || set.has('cm-hmd-internal-link');
      const isBarelink = set.has('cm-hmd-barelink');
      if (isWikilink) out.add('wikilink');
      const isAutolink = set.has('cm-md-autolink');
      if (isAutolink) out.add('link-url');
      if (
        !isWikilink &&
        !isBarelink &&
        !isAutolink &&
        (set.has('cm-md-link') || set.has('cm-link'))
      )
        out.add('link-text');
      if (set.has('cm-url') || set.has('cm-md-link-url')) out.add('link-url');
      // Task widgets/decorations are intentionally not bucketed — see
      // factory/driver/semanticKind.ts for the reasoning.
      if (set.has('cm-md-bullet') || set.has('cm-md-number')) out.add('list-marker');
      const isQuoteMarker =
        set.has('cm-formatting-quote') ||
        set.has('cm-md-quote-marker') ||
        set.has('cm-md-quote-marker-hidden');
      if (set.has('cm-md-quote-marker')) out.add('quote-marker');
      if (set.has('cm-md-quote-text')) out.add('quote-text');
      if (
        !isQuoteMarker &&
        [
          'cm-md-quote',
          'cm-md-quote-first',
          'cm-md-quote-middle',
          'cm-md-quote-last',
          'cm-md-quote-single',
          'cm-quote',
        ].some((c) => set.has(c))
      )
        out.add('quote-text');
      if (set.has('cm-md-hr-widget')) out.add('hr-widget');
      if (set.has('hr') && set.has('cm-line')) out.add('hr-widget');
      if (
        set.has('cm-md-image-widget') ||
        set.has('cm-md-image-wrapper') ||
        set.has('image-embed') ||
        set.has('image-wrapper')
      )
        out.add('image-widget');
      if (
        set.has('cm-md-table-rendered') ||
        set.has('cm-md-table-wrapper') ||
        set.has('sf-table') ||
        set.has('sf-table__scroll') ||
        set.has('cm-table-widget') ||
        set.has('table-wrapper')
      )
        out.add('table-widget');
      if (set.has('cm-md-tag')) out.add('tag');
      if (set.has('cm-hashtag') || set.has('cm-hashtag-end') || set.has('cm-hashtag-begin'))
        out.add('tag');
      if (out.size === 0) return ['unknown'];
      return [...out];
    };
    const extractDecs = (cm: any) => {
      const out: any[] = [];
      const root = cm.contentDOM as Element;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode() as Element | null;
      while (node) {
        // Skip cm-line containers — their child spans carry the
        // interesting decorations. Exception: cm-line.hr is how
        // Obsidian renders horizontal rules; capture those so the
        // hr-widget bucket lines up with SF's `cm-md-hr-widget`.
        const cl = node.classList;
        const isLine = cl.contains('cm-line');
        const isHrLine = isLine && cl.contains('hr');
        if (cl.length > 0 && (!isLine || isHrLine)) {
          const classes = Array.from(node.classList);
          const kinds = classToKinds(classes);
          const isUnknown = kinds.length === 1 && kinds[0] === 'unknown';
          const interesting =
            !isUnknown ||
            classes.some((c) =>
              /^cm-(md-|hashtag|formatting|strong|em|strikethrough|link|url|inline-code|header|quote)/.test(
                c,
              ),
            );
          if (interesting) {
            try {
              const fromPos = cm.posAtDOM(node, 0);
              const widget = isWidget(node);
              let toPos: number;
              if (widget) {
                const findNext = (start: Element): Element | null => {
                  let cur: Element | null = start;
                  while (cur && cur !== cm.contentDOM) {
                    let nx = cur.nextSibling as Element | null;
                    while (
                      nx &&
                      nx.nodeType === 1 &&
                      (nx as Element).classList?.contains('cm-widgetBuffer')
                    ) {
                      nx = nx.nextSibling as Element | null;
                    }
                    if (nx && nx.nodeType === 1) return nx as Element;
                    cur = cur.parentElement;
                  }
                  return null;
                };
                const next = findNext(node);
                toPos = next ? cm.posAtDOM(next, 0) : cm.state.doc.length;
                if (toPos <= fromPos) toPos = fromPos + 1;
              } else if (isHrLine) {
                // cm-line.hr is Obsidian's line-level HR. The textContent
                // is empty (the rendered <hr> has no chars), so fall back
                // to the line's source range so the bucket covers the
                // same span as SF's `cm-md-hr-widget`.
                const line = cm.state.doc.lineAt(fromPos);
                toPos = Math.min(line.to + 1, cm.state.doc.length);
              } else {
                toPos = fromPos + (node.textContent || '').length;
              }
              for (const kind of kinds) {
                out.push({
                  from: posToPos(cm, fromPos),
                  to: posToPos(cm, Math.max(toPos, fromPos)),
                  kind,
                  replaced: widget,
                  classes,
                  text: node.textContent || '',
                });
              }
            } catch (_) {
              /* detached */
            }
          }
        }
        node = walker.nextNode() as Element | null;
      }
      return out;
    };

    w.__driver = {
      async setDoc(markdown: string) {
        const cm = await ensureScratchCM();
        cm.dispatch({
          changes: { from: 0, to: cm.state.doc.length, insert: markdown },
          selection: { anchor: 0, head: 0 },
        });
        await tick();
      },
      async dispatch(events: any[]) {
        const cm = await ensureScratchCM();
        for (const ev of events) {
          switch (ev.type) {
            case 'place_cursor': {
              const pos = lineChToPos(cm, ev.line, ev.ch);
              cm.dispatch({ selection: { anchor: pos, head: pos } });
              cm.focus();
              break;
            }
            case 'type': {
              const sel = cm.state.selection.main;
              cm.dispatch({
                changes: { from: sel.from, to: sel.to, insert: ev.text || '' },
                selection: {
                  anchor: sel.from + (ev.text || '').length,
                  head: sel.from + (ev.text || '').length,
                },
              });
              break;
            }
            case 'key': {
              cm.contentDOM.dispatchEvent(
                new KeyboardEvent('keydown', { key: ev.key, bubbles: true, cancelable: true }),
              );
              break;
            }
            case 'blur':
              cm.contentDOM.blur();
              break;
            case 'focus':
              cm.focus();
              break;
            case 'set_doc': {
              cm.dispatch({
                changes: { from: 0, to: cm.state.doc.length, insert: ev.markdown || '' },
                selection: { anchor: 0, head: 0 },
              });
              break;
            }
          }
          await tick();
        }
      },
      async state() {
        const cm = await ensureScratchCM();
        const sel = cm.state.selection.main;
        const cursor = posToPos(cm, sel.head);
        const anchor = posToPos(cm, sel.anchor);
        return {
          doc: cm.state.doc.toString(),
          cursor,
          selection: { head: cursor, anchor },
          decorations: extractDecs(cm),
          visibleText: (cm.contentDOM as HTMLElement).innerText,
        };
      },
      async identify() {
        return { name: 'obsidian', version: w.app.appVersion || 'unknown' };
      },
    };
  });
}

function prepareObsidianRegistry(): () => void {
  const obsidianJson = path.join(OBSIDIAN_CONFIG_DIR, 'obsidian.json');
  const perVaultJson = path.join(OBSIDIAN_CONFIG_DIR, `${FACTORY_VAULT_ID}.json`);
  const backup = `${obsidianJson}.factory-bak`;

  // The "true original" is obsidian.json with NO factory vault registered.
  // Sanitize on the way in so a previous *crashed* run (which left the factory
  // vault registered + the real vaults closed) can't poison this run's backup
  // — restoring a poisoned backup is what stranded Obsidian on the factory
  // vault. If sanitizing closes every real vault, re-open the most-recent one
  // so the user lands on a real vault, not a blank picker.
  const sanitize = (raw: string): string => {
    const d = JSON.parse(raw);
    if (d.vaults) {
      delete d.vaults[FACTORY_VAULT_ID];
      const ks = Object.keys(d.vaults);
      if (ks.length && !ks.some((k) => d.vaults[k].open)) {
        ks.sort((a, b) => (d.vaults[b].ts ?? 0) - (d.vaults[a].ts ?? 0));
        d.vaults[ks[0]].open = true;
      }
    }
    return JSON.stringify(d);
  };

  let origRegistry: string | null = null;
  if (existsSync(backup)) {
    // A prior run died before its cleanup ran. Its backup is the best
    // not-yet-poisoned original we have — trust it over the live
    // obsidian.json (which is still in the factory-modified state) and
    // DON'T overwrite it, so the clean original survives this run too.
    origRegistry = readFileSync(backup, 'utf8');
  } else if (existsSync(obsidianJson)) {
    origRegistry = sanitize(readFileSync(obsidianJson, 'utf8'));
    writeFileSync(backup, origRegistry);
  }

  const data: any = origRegistry ? JSON.parse(origRegistry) : { vaults: {}, cli: true };
  data.vaults = data.vaults || {};
  for (const k of Object.keys(data.vaults)) data.vaults[k].open = false;
  data.vaults[FACTORY_VAULT_ID] = { path: VAULT_DIR, ts: Date.now(), open: true };
  data.cli = true;
  writeFileSync(obsidianJson, JSON.stringify(data));

  if (!existsSync(perVaultJson)) {
    writeFileSync(
      perVaultJson,
      JSON.stringify({
        x: 100,
        y: 100,
        width: 1280,
        height: 900,
        isMaximized: false,
        devTools: false,
        zoom: 0,
      }),
    );
  }

  return () => {
    try {
      if (origRegistry !== null) writeFileSync(obsidianJson, origRegistry);
      rmSync(backup, { force: true });
      rmSync(perVaultJson, { force: true });
    } catch (_) {
      /* best-effort */
    }
  };
}

async function tryFetch(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await tryFetch(url);
      return;
    } catch {}
    await delay(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setupVault() {
  mkdirSync(path.join(VAULT_DIR, '.obsidian'), { recursive: true });
  writeFileSync(
    path.join(VAULT_DIR, '.obsidian/app.json'),
    JSON.stringify({
      promptDelete: false,
      livePreview: true,
      foldHeading: false,
      foldIndent: false,
      safeMode: false,
      trustedTypes: true,
    }),
  );
  writeFileSync(
    path.join(VAULT_DIR, '.obsidian/workspace.json'),
    JSON.stringify({
      main: { id: 'root', type: 'split', children: [] },
      leftSplit: {},
      rightSplit: {},
      active: '',
      lastOpenFiles: [],
    }),
  );
  writeFileSync(
    path.join(VAULT_DIR, '.obsidian/appearance.json'),
    JSON.stringify({ accentColor: '' }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
