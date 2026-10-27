// Puppet-first gate — no instruction surface may teach an agent to DRIVE this app
// with anything but `just puppet`.
//
//   node scripts/check-puppet-first.mjs        (just check-puppet-first)
//
// WHY THIS EXISTS. `just puppet` makes every UI handler a verb, so acting through
// it runs the app's own code and answers with the diff it caused. It only helps
// if agents reach for it, and a measured pilot says they do not: five agents were
// handed a real bug report, told to reproduce it, and had the CLI documented in
// the repo. One used it — once, hit a misleading transport error, and fell back
// to `adb` for the remaining 85 tool calls. Four never ran the product at all and
// diagnosed from source; three shipped a fix that does not work and one shipped a
// regression that flips tables into raw markdown. Every one passed `just check`.
//
// A tool competing with four documented alternatives loses, because the
// alternatives are what the instruction surfaces still teach. So the rule is
// enforced where it is taught — the same shape as check-qa-input-safety, whose
// file discovery this reuses so the two gates can never disagree about what
// counts as an instruction surface.
//
// WHAT IS BANNED is UI DRIVING only. Screenshots, video, the vault on disk,
// device lifecycle and app-internal state readers are oracles, not drivers, and
// the `puppet` skill lists them as required. Banning those would make the rule
// unfollowable, and an unfollowable rule teaches agents that the whole thing is
// wrong.
//
// TWO ESCAPE HATCHES, because the verbs genuinely do not cover everything yet:
//
//   1. A SECTION marked with `<!-- check-puppet-first: <reason> -->` allows the
//      idiom until the next heading of any level. This is for native chrome the verbs
//      cannot reach — iOS Settings, sheets, the share sheet. It is a statement
//      that a gap exists, not a preference; close the gap and delete the marker.
//   2. An exact LINE pinned in the allowlist, for prose that names a retired
//      idiom in order to forbid it. A pinned line that disappears fails too, so
//      the allowlist cannot rot.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectInstructionFiles } from './check-qa-input-safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = 'scripts/puppet-first-allowlist.json';
const SECTION_MARKER = /<!--\s*check-puppet-first:\s*(.+?)\s*-->/;
const IOS_INSTEAD =
  '`FUTO_PUPPET_TARGET=ios just puppet do <Verb>` for anything the app owns, or `just puppet tap`/`drag` when the question is genuinely what a finger does — both traced, both answering with the diff.';

export const RULES = [
  {
    id: 'axe-input',
    why: 'axe drives the simulator from outside the app, so nothing it does runs through a handler and nothing reports what changed. `axe gesture`/`axe tap` also report success while doing nothing (AGENTS.md M21).',
    instead: IOS_INSTEAD,
    match: (line) => /\baxe\s+(tap|type|swipe|gesture|describe-ui|button|key)\b/.test(line),
  },
  {
    id: 'idb-input',
    why: 'idb drives the simulator from outside the app, as axe does: nothing it does runs through a handler and nothing reports what changed.',
    instead: IOS_INSTEAD,
    match: (line) => /\bidb\s+ui\b/.test(line),
  },
  {
    id: 'adb-input',
    why: 'a raw `adb … input` lands a touch at a device pixel with no idea what it hit and no record of what changed.',
    instead:
      '`FUTO_PUPPET_TARGET=android just puppet do <Verb>`, or `just puppet tap` — which takes CSS pixels, scales them by the display density, and prints every event the touch caused.',
    match: (line) => /\badb\b[^\n]*\binput\s+(tap|swipe|text|keyevent)\b/.test(line),
  },
  {
    id: 'os-input',
    why: 'OS-level input goes to whatever window has focus, which is the person at the machine, not the app (AGENTS.md M24), and nothing it does is traced.',
    instead:
      '`just puppet click|type|press`, which the app delivers to its own window in-process and answers with the diff.',
    // In command position, so prose naming a tool to forbid it stays writable; cliclick is
    // check-qa-input-safety's.
    match: (line) => /\b(xdotool|ydotool|wtype)\s+["'$\w-]/.test(line),
  },
  {
    id: 'uiautomator-dump',
    why: "uiautomator no longer ships on API 36 (`Killed` on every call), and where it did work it reported a tree with no notion of the app's own state.",
    instead: '`FUTO_PUPPET_TARGET=android just puppet elements` / `state`.',
    match: (line) => /\buiautomator\s+dump\b/.test(line),
  },
  {
    id: 'legacy-ui-reader',
    why: "the per-platform UI readers predate the puppet listener and answer from the accessibility tree, which cannot see the selection, the document or the app's own state.",
    instead: '`just puppet elements|state|doc|at|show`.',
    match: (line) =>
      /scripts\/describe-ios-ui\.mjs/.test(line) || /\bandroid-drive\s+tap\b/.test(line),
  },
  {
    id: 'bridge-input',
    why: "the MCP bridge's input calls synthesise events into the page; they are a second way to act that carries no receipt and no diff, so two drivers disagree about what the app just did.",
    instead:
      '`just puppet do <Verb>` for acting. The bridge stays for JS evaluation, which `just puppet` does not do; screenshots are `just puppet screenshot`.',
    // No leading \b: the tool is called as `mcp__tauri__webview_interact`, and `_` is a word character.
    match: (line) => /webview_(interact|keyboard)\b/.test(line),
  },
];

/** Every violation in one file's text, honouring section markers. */
export function scanText(text) {
  const lines = text.split('\n');
  const hits = [];
  let allowedReason = null;
  let inCodeBlock = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) inCodeBlock = !inCodeBlock;
    const marker = SECTION_MARKER.exec(line);
    if (marker) {
      allowedReason = marker[1];
      continue;
    }
    // The next heading of any level closes an open allowance, so a marker covers only the
    // section it sits in. A `#` line inside a code block is a shell comment.
    if (!inCodeBlock && /^#{1,6} /.test(line)) allowedReason = null;
    if (allowedReason) continue;
    for (const rule of RULES) {
      if (rule.match(line)) hits.push({ line: index + 1, rule: rule.id, text: line.trim() });
    }
  }
  return hits;
}

function loadAllowlist() {
  const full = path.join(ROOT, ALLOWLIST_PATH);
  if (!fs.existsSync(full)) return [];
  return JSON.parse(fs.readFileSync(full, 'utf8')).entries ?? [];
}

function main() {
  const files = collectInstructionFiles(ROOT);
  const allowlist = loadAllowlist();
  const pinned = new Map(
    allowlist.map((entry) => [`${entry.file}::${entry.rule}::${entry.text}`, entry]),
  );
  const matched = new Set();
  const violations = [];

  for (const full of files) {
    const relative = path.relative(ROOT, full);
    for (const hit of scanText(fs.readFileSync(full, 'utf8'))) {
      const key = `${relative}::${hit.rule}::${hit.text}`;
      if (pinned.has(key)) {
        matched.add(key);
        continue;
      }
      violations.push({ file: relative, ...hit });
    }
  }

  // A pin whose line is gone is itself a failure: the allowlist must describe
  // the repo as it is, or it silently licenses text nobody has read in months.
  const stale = [...pinned.keys()].filter((key) => !matched.has(key));

  if (!violations.length && !stale.length) {
    console.log(
      `check-puppet-first: OK (${files.length} instruction file(s), ${pinned.size} pinned line(s))`,
    );
    return;
  }
  for (const violation of violations) {
    const rule = RULES.find((r) => r.id === violation.rule);
    console.error(`\n${violation.file}:${violation.line}  [${violation.rule}]`);
    console.error(`  ${violation.text}`);
    console.error(`  why:     ${rule.why}`);
    console.error(`  instead: ${rule.instead}`);
  }
  for (const key of stale) {
    console.error(`\nstale allowlist entry (line no longer present): ${key}`);
  }
  console.error(
    `\ncheck-puppet-first FAILED: ${violations.length} violation(s), ${stale.length} stale pin(s).` +
      `\nIf the verbs genuinely cannot reach this surface, mark the SECTION with` +
      `\n  <!-- check-puppet-first: <why the verbs cannot reach it> -->` +
      `\nor pin the exact line in ${ALLOWLIST_PATH} with a reason.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
