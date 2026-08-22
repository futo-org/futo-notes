#!/usr/bin/env node
// Screenshot a desktop QA window WITHOUT activating it — no space switch, no
// stolen keyboard focus, no interruption to whoever is typing.
//
//   node scripts/qa-shot.mjs list                    # capturable windows of THIS worktree
//   node scripts/qa-shot.mjs pid <pid>   [--out <path>]
//   node scripts/qa-shot.mjs port <port> [--out <path>]
//
// Exit codes: 0 captured · 2 usage · 3 REFUSED (unsafe target) · 4 no such
// target/window · 5 captured a suspect (flat) frame — see checkFrame below.
//
// WHY THIS EXISTS. Several Claude sessions QA this app in parallel on one Mac
// with a single display. The documented way to raise a window
// (.claude/skills/verify/references/desktop.md — launch a second copy so
// tauri-plugin-single-instance calls window.set_focus() from Rust) is a
// deliberate focus steal, and that doc already notes "parallel sessions steal
// focus back within seconds". `open -a Simulator` does the same. The human
// trying to type in a terminal gets yanked between spaces mid-sentence.
//
// Almost none of that is necessary. A window's surface stays live and current
// while it sits on another space, so it can be captured where it is:
//
//   screencapture -x -o -l <windowID> out.png
//
// Verified 2026-08-20 on macOS 26.6.1: full-resolution (2x) captures of three
// off-space futo-notes-tauri windows, correct current content, with the
// frontmost app unchanged before and after.
//
// WHEN TO USE SOMETHING ELSE.
//   - Debug desktop build with a live bridge: prefer the bridge's
//     `capture_native_screenshot` (~19 ms, no Screen Recording permission).
//     This script is for when there is no bridge — an unknown/dead bridge port,
//     or a window whose process does not speak it.
//   - iOS simulator CONTENT: `xcrun simctl io <udid> screenshot` (just
//     sim-screenshot) needs no foreground Simulator either.
//   - Anything that awaits a frame (paint, rAF, scroll, animation): WebKit
//     suspends rendering while occluded, so those probes need a genuinely
//     VISIBLE window and this script cannot help. That is the one case that
//     wants a second display rather than better tooling.
//
// WHAT IT REFUSES. Capture is read-only — it cannot send input — but it can
// still read pixels, and the installed release app's window shows the user's
// real, E2EE-synced vault at ~/Documents/futo-notes. Screenshotting that would
// copy private note content into test-screenshots/ and into an agent's context.
// So this script captures ONLY windows owned by a process that
// scripts/qa-target.mjs verifies as a debug build of THIS worktree (M24), and
// fails closed on everything else. It deliberately offers no way to name a
// window by app or title: that is the "a name is not an identity" mistake in a
// new costume.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  allCandidatePids,
  candidateFor,
  repoRoot,
  verifyTarget,
  worktreeRoots,
} from './qa-target.mjs';
import os from 'node:os';

// Window records come back as TSV from a tiny Swift program (below). Anything
// on a layer other than 0 is chrome — menu bar extras, tooltips, the AutoFill
// panel — never the app window we mean.
const NORMAL_WINDOW_LAYER = 0;

// What one desktop instance actually owns in CGWindowList (measured 2026-08-20
// across five running instances, every one identical):
//
//   800x936  the real app window          <- the only one worth capturing,
//                                            and the ONLY one with a name
//                                            ("FUTO Notes (Dev)")
//   1512x33  x4, WebKit/titlebar strips   <- unnamed; also 33 < MIN_WINDOW_EDGE
//   500x500  a blank white helper surface <- unnamed, and it clears the size
//                                            filter, so size alone cannot
//                                            exclude it
//
// A contentless helper surface captures without error and looks like a
// legitimate screenshot of a blank app, so picking the right window matters more
// than it appears. Two independent discriminators, measured over 26 windows of 5
// instances: a non-empty name (5 named = exactly the 5 real windows) and largest
// area (480k vs 250k vs 50k). Name is preferred because it does not assume the
// window stays 800x600; area is the fallback, because kCGWindowName needs Screen
// Recording permission and comes back empty for everything without it.
//
// One real window per pid, so this tool captures exactly one and has no --all.
const MIN_WINDOW_EDGE = 200;

// `.optionAll` (not `.optionOnScreenOnly`) is the whole point: a window parked
// on another space is NOT "on screen", so the obvious enumeration finds nothing
// and tempts the caller into activating the app to make it appear.
const WINDOW_LIST_SWIFT = `
import CoreGraphics
import Foundation

let options = CGWindowListOption(arrayLiteral: .optionAll, .excludeDesktopElements)
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  FileHandle.standardError.write("CGWindowListCopyWindowInfo returned nothing\\n".data(using: .utf8)!)
  exit(1)
}
for window in windows {
  let id = window[kCGWindowNumber as String] as? Int ?? -1
  let pid = window[kCGWindowOwnerPID as String] as? Int ?? -1
  let layer = window[kCGWindowLayer as String] as? Int ?? -1
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = Int(bounds["Width"] as? Double ?? 0)
  let height = Int(bounds["Height"] as? Double ?? 0)
  // Name LAST, tabs stripped, so a titled window cannot shift the numeric fields.
  let name = (window[kCGWindowName as String] as? String ?? "")
    .replacingOccurrences(of: "\\t", with: " ")
    .replacingOccurrences(of: "\\n", with: " ")
  print("\\(id)\\t\\(pid)\\t\\(layer)\\t\\(width)\\t\\(height)\\t\\(name)")
}
`;

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in scripts/qa-shot.test.mjs)
// ---------------------------------------------------------------------------

/** Parse the Swift program's TSV into window records, dropping junk lines. */
export function parseWindowRecords(tsv) {
  const records = [];
  for (const rawLine of tsv.split('\n')) {
    // Only line endings are stripped, never trailing tabs: an unnamed window's
    // record legitimately ends with an empty final field.
    const line = rawLine.replace(/\r$/, '');
    const fields = line.split('\t');
    if (fields.length < 6) continue;
    const [id, pid, layer, width, height] = fields.slice(0, 5).map(Number);
    if (![id, pid, layer, width, height].every(Number.isInteger)) continue;
    if (id < 0 || pid < 0) continue;
    records.push({ id, pid, layer, width, height, name: fields.slice(5).join('\t') });
  }
  return records;
}

/**
 * The real app windows belonging to `pid`, best candidate first.
 *
 * A named window wins outright — only the real one carries a title. When no
 * candidate is named (kCGWindowName is empty for every window unless Screen
 * Recording permission is granted) this degrades to largest-area, which
 * discriminates the same way on measured data.
 */
export function selectWindows(records, pid) {
  const candidates = records.filter(
    (record) =>
      record.pid === pid &&
      record.layer === NORMAL_WINDOW_LAYER &&
      record.width >= MIN_WINDOW_EDGE &&
      record.height >= MIN_WINDOW_EDGE,
  );
  const named = candidates.filter((record) => (record.name ?? '') !== '');
  return (named.length > 0 ? named : candidates).sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );
}

/**
 * Where the capture is written: `--out` verbatim, else test-screenshots/ next
 * to every other QA artifact, named so parallel worktrees cannot collide.
 */
export function captureDestination(window, { out = null, defaultDir } = {}) {
  return out ?? path.join(defaultDir, `qa-${window.pid}-${window.id}.png`);
}

/**
 * How many distinct colours a capture holds, and the share taken by the most
 * common one.
 *
 * Guards against the one failure this tool could otherwise hide: a capture that
 * succeeds and returns a plausible-looking but CONTENTLESS frame — a single flat
 * colour — which reads as "the app rendered nothing" and would be believed.
 * Losing an hour to a screenshot that lies is worse than an occasional
 * false alarm, so this fails loud (exit 5) rather than warning quietly.
 *
 * Thresholds come from measurement, not taste. Real captures (2026-08-20, both
 * themes, 800x600 to 940x668): five off-space windows ran 753-1414 distinct
 * colours at 40.3%-66.0% dominant, and a mostly-empty note view hit 307 colours
 * at 88.5% dominant — so a "90% means blank" rule would have failed a perfectly
 * good screenshot. A contentless frame is 1 colour at 100%. The trigger sits at
 * 99%, which no real UI has approached, however sparse.
 */
export function analyzeFrame({ width, height, data }) {
  const counts = new Map();
  for (let index = 0; index < data.length; index += 4) {
    const rgb = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  let dominant = 0;
  let dominantCount = 0;
  for (const [rgb, count] of counts) {
    if (count > dominantCount) [dominant, dominantCount] = [rgb, count];
  }
  const total = width * height;
  return {
    distinct: counts.size,
    dominant: `#${dominant.toString(16).padStart(6, '0')}`,
    dominantShare: total > 0 ? dominantCount / total : 1,
  };
}

const SUSPECT_DOMINANT_SHARE = 0.99;

/** True when a capture carries no discernible content. */
export function isSuspectFrame({ distinct, dominantShare }) {
  return distinct <= 2 || dominantShare >= SUSPECT_DOMINANT_SHARE;
}

/** Split argv into a command, its argument, and flags. */
export function parseArgs(argv) {
  const positional = [];
  let out = null;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--out') out = argv[++index] ?? null;
    else if (token.startsWith('--out=')) out = token.slice('--out='.length);
    else positional.push(token);
  }
  return { command: positional[0], argument: positional[1], out };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function listWindowRecords() {
  const result = spawnSync('swift', ['-'], { input: WINDOW_LIST_SWIFT, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    console.error('qa-shot: `swift` not found — install Xcode or the Command Line Tools.');
    return null;
  }
  if (result.status !== 0) {
    console.error(`qa-shot: window enumeration failed: ${(result.stderr || '').trim()}`);
    return null;
  }
  return parseWindowRecords(result.stdout);
}

/** Capture one window. Returns an exit code: 0 ok · 4 failed · 5 suspect frame. */
function capture(window, file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  // -x no shutter sound · -o no window shadow · -l capture THIS window id,
  // wherever it lives. No activation, so nothing moves on the user's screen.
  const result = spawnSync('screencapture', ['-x', '-o', '-l', String(window.id), file], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !fs.existsSync(file)) {
    console.error(
      `qa-shot: screencapture failed for window ${window.id}: ${(result.stderr || '').trim()}`,
    );
    console.error('  If this is a permission error, grant Screen Recording to your terminal in');
    console.error('  System Settings › Privacy & Security › Screen Recording.');
    return 4;
  }
  const bytes = fs.statSync(file).size;
  console.log(`  ${file}  (${window.width}x${window.height} pt, ${bytes} bytes)`);
  return checkFrame(file) ? 0 : 5;
}

/**
 * Report whether the capture actually contains something. Returns false ONLY
 * for a frame proven contentless — if the check itself cannot run, the capture
 * still stands and we say the check was skipped, rather than failing a good
 * screenshot or silently implying it was verified.
 */
function checkFrame(file) {
  let png;
  try {
    const { PNG } = createRequire(import.meta.url)('pngjs');
    png = PNG.sync.read(fs.readFileSync(file));
  } catch (error) {
    console.log(`  (frame content NOT verified: ${error.message})`);
    return true;
  }
  const analysis = analyzeFrame(png);
  if (!isSuspectFrame(analysis)) {
    console.log(
      `  frame ok: ${analysis.distinct} distinct colours, most common ${analysis.dominant} at ${(analysis.dominantShare * 100).toFixed(1)}%`,
    );
    return true;
  }
  console.error(
    `  SUSPECT FRAME: ${analysis.distinct} distinct colour(s), ${analysis.dominant} covers ${(analysis.dominantShare * 100).toFixed(1)}%.`,
  );
  console.error('  The capture succeeded but holds no content, so do NOT read a UI verdict from');
  console.error('  it. Likely the window has not painted yet (app still booting, dev server not');
  console.error('  up) rather than anything about which space it is on — five off-space windows');
  console.error('  captured full content when this check was written. Confirm through the bridge');
  console.error('  (capture_native_screenshot / webview_dom_snapshot) before believing either.');
  return false;
}

/**
 * Resolve a pid to a verified QA target, printing the refusal if it is not one.
 * Returns `{ ok: true }` or `{ ok: false, code }`, where code matches
 * qa-target.mjs's contract: 3 refused (a real process we will not touch),
 * 4 no such target (nothing to refuse).
 */
function verifiedPid(pid, context) {
  const candidate = candidateFor(pid);
  if (!candidate.execPath) {
    console.error(`pid ${pid} — no such process, or its executable path is unreadable.`);
    return { ok: false, code: 4 };
  }
  const result = verifyTarget(candidate, context);
  if (result.verdict !== 'verified') {
    console.error(`REFUSED  pid ${pid} (${candidate.execPath})`);
    for (const refusal of result.refusals) console.error(`  [${refusal.code}] ${refusal.detail}`);
    console.error('  qa-shot captures only a debug build of THIS worktree — a window can show');
    console.error("  the user's real vault, and a process name cannot tell the builds apart.");
    return { ok: false, code: 3 };
  }
  return { ok: true };
}

const USAGE = `usage:
  node scripts/qa-shot.mjs list                  capturable windows of THIS worktree
  node scripts/qa-shot.mjs pid <pid>   [--out <path>]
  node scripts/qa-shot.mjs port <port> [--out <path>]

Captures without activating: no space switch, no stolen focus. Debug builds of
this worktree only (exit 3 = refused). With a live bridge, prefer its
capture_native_screenshot instead.`;

function main(argv) {
  if (process.platform !== 'darwin') {
    console.error('qa-shot: macOS only (CGWindowList + screencapture).');
    return 2;
  }

  const { command, argument, out } = parseArgs(argv);
  const selfRoot = repoRoot();
  const context = { worktreeRoots: worktreeRoots(selfRoot), selfRoot, home: os.homedir() };
  const defaultDir = path.join(selfRoot ?? process.cwd(), 'test-screenshots');

  if (command === 'list') {
    const records = listWindowRecords();
    if (!records) return 4;
    let found = 0;
    for (const pid of allCandidatePids()) {
      const candidate = candidateFor(pid);
      if (verifyTarget(candidate, context).verdict !== 'verified') continue;
      // Only the window `pid`/`port` would actually capture — listing the blank
      // helper surface as "capturable" would be advertising a useless PNG.
      const [window] = selectWindows(records, pid);
      if (!window) continue;
      console.log(
        `  window ${String(window.id).padStart(7)}  ${`${window.width}x${window.height}`.padEnd(11)} pid ${String(pid).padEnd(7)} ${window.name || '<unnamed>'}`,
      );
      found++;
    }
    if (found === 0) {
      console.log('no capturable window: no verified instance of this worktree is running.');
      console.log(
        '  `node scripts/qa-target.mjs list` says what IS running, and why it is refused.',
      );
    }
    return 0;
  }

  if (command !== 'pid' && command !== 'port') {
    console.error(USAGE);
    return 2;
  }

  const numeric = Number(argument);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    console.error(USAGE);
    return 2;
  }

  // Port → pid goes through qa-target's own CLI so there is exactly one
  // implementation of "who is listening here", and it is the audited one.
  let pid = numeric;
  if (command === 'port') {
    const resolved = spawnSync(
      process.execPath,
      [
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'qa-target.mjs'),
        'port',
        String(numeric),
      ],
      { encoding: 'utf8' },
    );
    if (resolved.status !== 0) {
      process.stderr.write(resolved.stderr || '');
      process.stdout.write(resolved.stdout || '');
      return resolved.status === 3 ? 3 : 4;
    }
    const match = /VERIFIED QA TARGET\s+pid (\d+)/.exec(resolved.stdout || '');
    if (!match) {
      console.error(`qa-shot: could not read a verified pid for port ${numeric}.`);
      return 4;
    }
    pid = Number(match[1]);
  }

  const verified = verifiedPid(pid, context);
  if (!verified.ok) return verified.code;

  const records = listWindowRecords();
  if (!records) return 4;

  const windows = selectWindows(records, pid);
  if (windows.length === 0) {
    console.error(`qa-shot: pid ${pid} is verified but owns no app window yet.`);
    return 4;
  }

  const [window] = windows;
  console.log(`capturing window ${window.id} of pid ${pid} — no activation:`);
  return capture(window, captureDestination(window, { out, defaultDir }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
