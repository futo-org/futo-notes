// QA input-safety gate — no instruction surface may teach an agent to drive
// this app with OS-level input, or to find (or kill) it by process name.
//
//   node scripts/check-qa-input-safety.mjs        (just check-qa-input-safety)
//
// WHY THIS EXISTS. 2026-08-10: during a parallel MR-QA pass an agent resolved a
// PID by matching the process name `futo-notes-tauri`, then sent real Cmd+Z
// keystrokes to it through AppleScript UI scripting. Every build ships that same
// name — the installed release app's executable really is
// `/Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri` — and several
// builds run at once during parallel QA, so the lookup resolved to the USER'S
// PRODUCTION APP, which owns the real E2EE-synced vault at ~/Documents/futo-notes.
// The undo landed there. The vault survived on luck: that instant happened to be
// a sync pull rather than a dirty editor followed by autosave.
//
// Two properties made it possible, and both are addressed here:
//   1. Real keystrokes/clicks go to whatever the window server thinks is
//      FOCUSED. They are not addressed to the PID you resolved, so no amount of
//      care in picking the PID makes them safe. The agent's own webview even
//      reported `document.hasFocus() === false` — after the keys had gone out.
//   2. A process NAME is not an identity. Name/PID lookups against this app
//      cannot distinguish release from dev from another worktree's QA build.
//
// Agents follow instruction files literally — that is exactly how this happened,
// from a technique recorded in a previous QA ledger. So the rule is enforced
// where it is taught, not just written down: any of the patterns in RULES below,
// appearing in any instruction surface, fails this gate.
//
// The allowlist (scripts/qa-input-safety-allowlist.json) pins EXACT lines, so
// the prose that names a banned technique in order to forbid it stays legal
// while a fresh occurrence — even in the same file — still fails. A pinned line
// that disappears fails too, so the allowlist cannot rot.
//
// WHY IT ALSO COVERS TERMINATION. 2026-08-19: six agents worked in parallel
// worktrees on one machine, and three of them independently reached for a
// pattern kill to clean up after themselves — `pkill -f "cargo tauri dev"`,
// `pkill -f "cargo  run --no-default-features"`, `pkill -f vite`. Each one is
// machine-wide. The first two killed OTHER worktrees' Tauri supervisors,
// orphaning their app binaries: an orphan keeps serving its DevTools/MCP bridge
// while it stops rebuilding, so a peer spent a long time concluding its change
// "had no effect" from a build that never happened. The third took every
// worktree's dev server to zero at once, mid-Playwright-run. Nobody got an
// exception; they got plausible wrong answers, which is the worst shape a
// failure can have. Same root cause as the 2026-08-10 incident — a process name
// is not an identity — so it is the same gate, not a sibling.
//
// SCOPE / LIMITS. This gate reads instruction surfaces (Markdown + agent/skill
// definitions) plus the root `justfile`, not source code: a comparison harness
// may legitimately script a DIFFERENT application (the removed factory/ judge
// drove Obsidian that way), and banning the mechanism in TypeScript would be a
// different rule with different trade-offs. The justfile is in because AGENTS.md imports it by reference
// (`@justfile`), so it is loaded into every agent's context as instruction, and
// because it is the one file in this repo that demonstrates a pattern kill —
// `deploy-deb`/`deploy-rpm` legitimately stop every instance right before
// overwriting /usr/bin. Those two lines are pinned; a THIRD one is a violation.
//
// It cannot see gitignored working files (QA ledgers under test-screenshots/) or
// an agent's own memory outside the repo, and — unlike scripts/qa-target.mjs,
// which refuses an unsafe target at runtime — nothing intercepts a pkill an
// agent types straight into a shell. This gate stops the repo TEACHING the
// idiom; it is not a runtime guard, which is why the safe technique is
// documented alongside every ban.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = 'scripts/qa-input-safety-allowlist.json';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  '.build',
  '.build-device',
  '.build-device-release',
]);

// ---------------------------------------------------------------------------
// Shapes shared by the two process-identity rules
// ---------------------------------------------------------------------------

// The command verb must be on THIS line (so a violation is reported where it
// lives), but the app name may wrap onto the next — these commands are
// routinely line-wrapped in Markdown prose.
const APP_NAME_LOOKUP_VERB = /\b(pgrep|pkill|killall)\b/;
const APP_BINARY_NAME = /(futo-notes-tauri|FUTO Notes)/;
const namesTheApp = (line, nextLine) =>
  APP_NAME_LOOKUP_VERB.test(line) && APP_BINARY_NAME.test(`${line} ${nextLine ?? ''}`);

// A pattern that can only ever match processes launched from THIS checkout —
// the one legal shape of a pattern kill.
const WORKTREE_ANCHORED = /\$\{?PWD\}?|\$\(pwd\)|\$CI_PROJECT_DIR|\bworktrees\//;

// A kill in COMMAND position: the verb followed by a flag, a quote, a variable
// or a name. A bare mention of the verb in prose that FORBIDS it (``pkill``
// inside backticks, no argument) is not a command, and has to stay writable —
// otherwise the ban cannot be documented. `kill <pid>` is deliberately absent:
// a PID is an identity, and it is the sanctioned form.
const KILL_BY_PATTERN = [
  /\b(pkill|killall)\s+["'$\w-]/,
  /\bkill\b[^\n]*\$\(\s*pgrep\b/,
  /\bpgrep\b[^\n]*\|[^\n]*\bxargs\b[^\n]*\bkill\b/,
];

// ---------------------------------------------------------------------------
// The banned patterns
//
//   id      stable name, reported and used in the allowlist's rule field
//   why     what goes wrong (printed on every violation)
//   instead the sanctioned technique
//   match   (line, nextLine) => boolean
// ---------------------------------------------------------------------------

export const RULES = [
  {
    id: 'system-events-ui-scripting',
    why: "AppleScript UI scripting sends input to the FOCUSED window, not to the process you named. During parallel QA that focused window was the installed production app on the user's real vault.",
    instead:
      "drive the debug build's webview bridge (.claude/skills/verify/references/desktop.md), which can only reach the instance you connected to.",
    match: (line) => /System Events/.test(line),
  },
  {
    id: 'applescript-keystroke',
    why: 'a synthetic keystroke is delivered by the window server to whatever is focused — it cannot be addressed to a PID, so it can always land in the wrong app.',
    instead:
      "webview_keyboard / webview_execute_js against the bridge port of a target verified by `node scripts/qa-target.mjs`, or document.execCommand('insertText') for CodeMirror.",
    match: (line) => /\bkeystroke\s+["'“]/.test(line) || /\bkey code\s+\d/.test(line),
  },
  {
    id: 'cliclick',
    why: 'cliclick clicks at screen coordinates in whatever app is frontmost — it has no notion of which instance you meant.',
    instead:
      'webview_interact by ref/selector/text through the bridge, or a native screenshot plus bridge-mediated interaction.',
    match: (line) => /\bcliclick\b/.test(line),
  },
  {
    id: 'unix-id-process-lookup',
    why: "AppleScript's `unix id` lookup turns a PID into a UI-scriptable application process — the exact step that let real keystrokes reach the production app.",
    instead:
      '`node scripts/qa-target.mjs pid <pid>` / `port <port>`, which verifies the executable is a debug build inside THIS worktree and refuses anything else.',
    match: (line) => /\bunix id\b/i.test(line),
  },
  {
    id: 'app-process-name-lookup',
    why: 'every build of this app shares the binary name `futo-notes-tauri`, including /Applications/FUTO Notes.app and each parallel worktree — a name or PID match cannot tell them apart.',
    instead:
      "`node scripts/qa-target.mjs list|pid|port|kill`, the only sanctioned resolver: it classifies by real executable path, this repo's worktree list, and the instance's own data dir and vault.",
    match: namesTheApp,
  },
  {
    id: 'process-name-kill',
    why: 'up to seven checkouts of this repo run at once on this machine and every one of them spawns identically-named processes (`vite`, `cargo tauri dev`, `node`, `gradle`), so a pattern kill is machine-wide. The damage is silent and shaped like a wrong answer rather than an error: an orphaned app keeps serving its bridge port while it stops rebuilding, and a killed dev server hands an in-flight test run a screenshot of an error overlay instead of a failure.',
    instead:
      'kill by identity, not by name — `just qa-target kill` for this worktree\'s desktop instances (it refuses anything that is not a debug build of THIS checkout), the PID or process group you recorded when you started the job, or the port this worktree owns (`just ports`). A pattern kill is legal only when the pattern itself is scoped to this checkout (`pkill -f "$PWD"`).',
    // Complementary to app-process-name-lookup by construction: that rule owns
    // every line spelling the desktop binary, this one owns the rest. One
    // dangerous line therefore reports under exactly one id and needs exactly
    // one allowlist entry.
    match: (line, nextLine) =>
      !namesTheApp(line, nextLine) &&
      !WORKTREE_ANCHORED.test(line) &&
      KILL_BY_PATTERN.some((shape) => shape.test(line)),
  },
  {
    id: 'relative-newermt',
    why: 'BSD/macOS `find -newermt` silently matches NOTHING for a relative time like "-24 hours" instead of erroring, so a safety check written this way reports an all-clear it never performed (this is how the incident\'s first vault check came back falsely clean).',
    instead:
      '`touch -t <absolute stamp> /tmp/ref && find … -newer /tmp/ref`, or an absolute `-newermt "2026-08-10 12:00:00"`.',
    match: (line) =>
      /-newer[mca]t\s+["']?-/.test(line) ||
      /-newer[mca]t\s+["']?[^"']*\b(ago|hour|day|minute|week|month|year)/i.test(line),
  },
];

// ---------------------------------------------------------------------------
// Instruction-surface discovery
// ---------------------------------------------------------------------------

function findFiles(dir, matches, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A nested checkout (repo-local worktree) carries its own instruction
      // surfaces on its own branch — not this commit's to validate.
      if (fs.existsSync(path.join(full, '.git'))) continue;
      findFiles(full, matches, out);
    } else if (matches(full)) {
      out.push(full);
    }
  }
  return out;
}

export function collectInstructionFiles(root) {
  const files = [];

  // `justfile` is an instruction surface, not just tooling: AGENTS.md imports it
  // by reference (`@justfile`), so every agent has it in context, and it is
  // where the pattern-kill idiom is demonstrated (see the header).
  for (const name of ['README.md', 'CONTRIBUTING.md', 'justfile']) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) files.push(full);
  }
  files.push(...findFiles(root, (full) => path.basename(full) === 'AGENTS.md'));
  files.push(...findFiles(path.join(root, 'docs'), (full) => full.endsWith('.md')));
  files.push(...findFiles(path.join(root, '.claude', 'skills'), (full) => full.endsWith('.md')));
  files.push(...findFiles(path.join(root, '.claude', 'agents'), (full) => full.endsWith('.md')));
  files.push(
    ...findFiles(
      path.join(root, '.claude', 'workflows'),
      (full) => full.endsWith('.js') || full.endsWith('.mjs'),
    ),
  );

  return [...new Set(files)];
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Every banned-pattern hit in one file's text, as {line, rule, text}. */
export function scanText(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.match(lines[i], lines[i + 1])) {
        hits.push({ line: i + 1, rule: rule.id, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

/**
 * Split hits into violations and satisfied allowlist entries.
 *
 * An entry matches by (rule, exact trimmed line text) within its file, so a
 * reworded or newly-added occurrence is a violation even in an allowlisted
 * file. Entries are consumed at most once per occurrence, and any entry left
 * unconsumed is stale.
 */
export function applyAllowlist(hitsByFile, allowlist) {
  const violations = [];
  const staleEntries = [];
  const consumed = new Map();

  for (const [file, hits] of Object.entries(hitsByFile)) {
    const entries = allowlist[file] ?? [];
    const remaining = entries.map((entry, index) => ({ entry, index, used: false }));
    for (const hit of hits) {
      const slot = remaining.find(
        (candidate) =>
          !candidate.used &&
          candidate.entry.rule === hit.rule &&
          candidate.entry.line.trim() === hit.text,
      );
      if (slot) {
        slot.used = true;
        continue;
      }
      violations.push({ file, ...hit });
    }
    consumed.set(file, remaining);
  }

  for (const [file, entries] of Object.entries(allowlist)) {
    const remaining = consumed.get(file);
    if (!remaining) {
      staleEntries.push({
        file,
        entry: entries[0],
        reason: 'the file has no such occurrence any more (or is no longer scanned)',
      });
      continue;
    }
    for (const candidate of remaining) {
      if (!candidate.used) {
        staleEntries.push({
          file,
          entry: candidate.entry,
          reason: 'no line in the file matches this pinned text for that rule',
        });
      }
    }
  }

  return { violations, staleEntries };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const files = collectInstructionFiles(ROOT);
  const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST_PATH), 'utf8')).allowed;

  const hitsByFile = {};
  for (const file of files) {
    const hits = scanText(fs.readFileSync(file, 'utf8'));
    if (hits.length > 0) hitsByFile[path.relative(ROOT, file).replaceAll(path.sep, '/')] = hits;
  }

  const { violations, staleEntries } = applyAllowlist(hitsByFile, allowlist);
  const ruleById = new Map(RULES.map((rule) => [rule.id, rule]));

  if (violations.length > 0 || staleEntries.length > 0) {
    console.error('QA input-safety gate FAILED:\n');
    for (const violation of violations) {
      const rule = ruleById.get(violation.rule);
      console.error(`  ${violation.file}:${violation.line}  [${violation.rule}]`);
      console.error(`    found:   ${violation.text}`);
      console.error(`    why:     ${rule.why}`);
      console.error(`    instead: ${rule.instead}`);
      console.error('');
    }
    for (const stale of staleEntries) {
      console.error(`  ${ALLOWLIST_PATH}  stale entry for ${stale.file} [${stale.entry?.rule}]`);
      console.error(`    pinned:  ${stale.entry?.line}`);
      console.error(`    why:     ${stale.reason} — delete the entry, or re-pin it.`);
      console.error('');
    }
    console.error(
      `${violations.length} banned QA-input pattern(s) and ${staleEntries.length} stale allowlist ` +
        `entry(ies) across ${files.length} instruction file(s).\n` +
        "These techniques sent real Cmd+Z keystrokes into the user's production vault once (M24), " +
        "and killed three peer worktrees' dev stacks in one hour (M25). Do not allowlist a new " +
        'occurrence to get green — use scripts/qa-target.mjs, the webview bridge, and a PID or port ' +
        'you own.',
    );
    process.exit(1);
  }

  const pinned = Object.values(allowlist).reduce((sum, entries) => sum + entries.length, 0);
  console.log(
    `QA input-safety gate OK — ${files.length} instruction file(s) scanned against ${RULES.length} ` +
      `banned pattern(s), ${pinned} pinned exception(s), 0 violations.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
