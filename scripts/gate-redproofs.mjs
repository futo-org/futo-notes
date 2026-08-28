// Gate red-proof harness — the meta-gate that proves the other gates work.
//
//   node scripts/gate-redproofs.mjs                (just gate-redproofs)
//   node scripts/gate-redproofs.mjs --self-test    (only the harness self-test)
//   node scripts/gate-redproofs.mjs --include-cargo  (adds the cargo-dependent proof)
//
// WHY THIS EXISTS. "Silent green" is this repo's #1 root-cause class, and the
// guards themselves are not exempt: d87173eb (a commented-out invoke() counted
// as a live caller), 54d1cc41 (the ratchet counted files, not call sites; the
// drift registry missed the canonical copy), 90a62902 (the drift scan matched
// only one literal shape), a6c6e2d5 (the ratchet's compare loop never read an
// unmatched JSON entry, so a retired counter could never be retired),
// db31586c (the docs-only CI fast path skipped check-agent-docs). Every one of
// those gates was GREEN while stepping over a real violation. Every gate this
// repo has added later needed a red-proof it did not originally have — this is
// that standing red-proof (AGENTS.md M11: no silent green).
//
// WHAT IT PROVES. For each covered gate, both directions:
//   GREEN — the gate exits 0 on a pristine checkout (otherwise a red-proof is
//           vacuous: a gate that is always red proves nothing).
//   RED   — with ONE seeded violation injected, the gate exits non-zero AND
//           its output names the seeded violation. Exit-code-only is
//           deliberately not accepted: a gate that dies on a missing module
//           also exits non-zero, and counting that as "the gate works" is the
//           exact failure this harness exists to catch.
//
// HOW. One throwaway `git worktree` in the system temp dir (never inside the
// repo — a stray directory there would itself trip drift-check's
// deny-by-default scan). Per proof: inject → run the gate with cwd there →
// assert → revert → assert the worktree is byte-clean again. The real
// checkout is never touched.
//
// LIMITATION, read this before trusting a green run: the proof worktree is
// built from `git stash create` (your tracked edits, staged or not) or, with a
// clean tree, from HEAD. UNTRACKED files do not exist in it. A brand-new gate
// script that has never been `git add`ed therefore cannot be proved — the
// harness prints the untracked files it had to leave behind rather than
// pretending otherwise.
//
// ADDING A GATE. Append to PROOFS below: the gate command, one seeded
// violation that hits the gate's PRIMARY claim, the substrings its output must
// contain, and a `fix:` line telling the next person what to do when the proof
// goes red. A proof without a marker assertion is not a proof.
//
// Note for editors: this harness is documented here and in the justfile
// recipe rather than in AGENTS.md, to keep the root manual to rules agents
// must follow rather than rationale for the tooling that checks them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Gate commands (how each gate is invoked inside the proof worktree)
// ---------------------------------------------------------------------------

const GATES = {
  'command-reachability': ['node', ['scripts/check-command-reachability.mjs']],
  'platform-discipline': ['node', ['scripts/check-platform-discipline.mjs']],
  'drift-check': ['node', ['scripts/drift-check.mjs']],
  'agent-docs': ['node', ['scripts/check-agent-docs.mjs']],
  'qa-input-safety': ['node', ['scripts/check-qa-input-safety.mjs']],
  'spec-gaps': ['node', ['scripts/spec-gaps.mjs', '--check']],
  'toolbar-spec': ['node_modules/.bin/tsx', ['scripts/gen-toolbar-spec.ts', '--check']],
  'title-spec': ['node_modules/.bin/tsx', ['scripts/gen-title-spec.ts', '--check']],
  'bridge-spec': ['node_modules/.bin/tsx', ['scripts/gen-bridge-spec.ts', '--check']],
  'theme-single-pace': ['node', ['scripts/check-theme-single-pace.mjs']],
  'rust-dependency-boundaries': ['node', ['scripts/check-rust-dependency-boundaries.mjs']],
};

// Gates whose proof needs a Rust toolchain. Kept out of the default run so the
// harness can live in `check:arch-gate:portable`, which CI runs in an image
// with no cargo.
const CARGO_GATES = new Set(['rust-dependency-boundaries']);

// Gates this harness deliberately does NOT cover, printed on every run so the
// hole is visible rather than assumed closed (M11 applies to the harness too).
const NOT_COVERED = [
  {
    gate: 'sync-contract (cargo test -p futo-notes-tauri generated_typescript_contract_is_current)',
    why: 'the proof would have to compile the desktop Tauri crate (GTK/webkit link, minutes per run) — far outside this harness’s seconds-scale budget. It is exercised by the Rust workspace job instead.',
  },
  {
    gate: 'lint:platform (package.json git-grep one-liner)',
    why: 'not a script with its own failure reporting — it is a negated `git grep`, so a red run prints grep output and nothing else. The boundary it half-guards is red-proved by the platform-discipline proofs above.',
  },
];

// Generated-contract targets, for the three gen-*-spec proofs.
const TOOLBAR_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/ToolbarSpec.swift';
const TOOLBAR_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/ToolbarSpec.kt';
const TITLE_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/TitleSpec.swift';
const TITLE_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/TitleSpec.kt';
const BRIDGE_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/BridgeSpec.swift';
const BRIDGE_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/BridgeSpec.kt';

// The live closure probe the `spec-gaps/closure-probe-fires` proof borrows (issue
// #80, the Android dropped-keystroke divergence). A closure probe fires only when
// BOTH halves line up — a gap note its `match` hits, and codebase evidence its
// `closed()` finds — so the proof has to seed both. These name the two halves:
// the phrase the probe matches on, and the file plus the vocabulary its
// `closed()` greps for.
//
// A probe is retired the moment its gap closes, which is a NORMAL, healthy
// event — so the proof asserts the coupling itself and fails loudly with
// instructions when this probe goes. Do not silently delete the proof: repoint
// these four constants at another live probe in scripts/spec-gaps.mjs.
const CLOSURE_PROBE_GAP_PHRASE = 'destructive latch is DROPPED on Android';
const CLOSURE_PROBE_EVIDENCE_FILE =
  'apps/android/app/src/main/java/com/futo/notes/ui/EditorSession.kt';
const CLOSURE_PROBE_EVIDENCE_ANCHOR = 'package com.futo.notes.ui';
const CLOSURE_PROBE_EVIDENCE_VOCAB = 'quarantine';

// ---------------------------------------------------------------------------
// Seeding helpers — every mutation goes through these so revert stays simple
// ---------------------------------------------------------------------------

const seed = {
  write(wt, rel, content) {
    const abs = path.join(wt, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  },
  append(wt, rel, content) {
    fs.appendFileSync(path.join(wt, rel), content);
  },
  replace(wt, rel, from, to) {
    const abs = path.join(wt, rel);
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(from)) {
      throw new Error(`seed.replace: ${rel} no longer contains ${JSON.stringify(from)}`);
    }
    fs.writeFileSync(abs, text.replace(from, to));
  },
  json(wt, rel, mutate) {
    const abs = path.join(wt, rel);
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    mutate(data);
    fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  },
  read(wt, rel) {
    return fs.readFileSync(path.join(wt, rel), 'utf8');
  },
  readJson(wt, rel) {
    return JSON.parse(fs.readFileSync(path.join(wt, rel), 'utf8'));
  },
};

const SENTINEL_HEADER =
  '// Seeded by scripts/gate-redproofs.mjs inside a throwaway git worktree. If you are\n' +
  '// reading this in a real checkout, a proof failed to revert — delete the file.\n';

// ---------------------------------------------------------------------------
// The proof registry
//
// Each entry:
//   gate        key into GATES
//   id          stable name, `gate/id` is what the report prints
//   seeded      one line describing the injected violation (shown on failure)
//   claim       the gate's own promise this proof is testing
//   inject(wt)  perform the injection
//   expect      substrings the gate output MUST contain (string[] or (wt) => string[]);
//               computed BEFORE injection so a proof can key off the pristine baseline
//   absent      substrings the output must NOT contain — discrimination, so a
//               gate that fails everything can't pass as a working gate
//   marker      omit for the strong kind — a token this proof invented and the
//               gate echoed back. Set 'claim' where the gate reports staleness
//               without echoing any content, so the assertion has to be the
//               gate's own failure sentence; the report labels those so a reader
//               can see which proofs are the weaker kind. Either way it still
//               separates "detected" from "crashed", which is the line that matters.
//   fix         remediation printed when the proof fails
// ---------------------------------------------------------------------------

const PROOFS = [
  {
    gate: 'command-reachability',
    id: 'invoke-of-unregistered-command',
    seeded:
      "created src/redproof-sentinel-invoke.ts calling invoke('redproof_sentinel_unregistered')",
    claim: 'an invoke() of a name that is not registered in generate_handler![...] must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'src/redproof-sentinel-invoke.ts',
        `${SENTINEL_HEADER}export const probe = () => invoke('redproof_sentinel_unregistered');\n`,
      ),
    expect: [
      'redproof_sentinel_unregistered',
      'does not match any command registered',
      'src/redproof-sentinel-invoke.ts',
    ],
    fix: 'check INVOKE_RE and the walk()/stripComments() filters in scripts/check-command-reachability.mjs — a caller in a scanned src/ file stopped being seen (this is exactly the d87173eb class of bug).',
  },
  {
    gate: 'command-reachability',
    id: 'stale-allowlist-entry',
    seeded:
      "added 'redproof_sentinel_deleted' to scripts/command-reachability-allowlist.json (no such Rust command)",
    claim: 'an allowlist entry for a command that no longer exists in Rust must fail',
    inject: (wt) =>
      seed.json(wt, 'scripts/command-reachability-allowlist.json', (data) => {
        data.redproof_sentinel_deleted = 'seeded by the gate red-proof harness';
      }),
    expect: ['redproof_sentinel_deleted', 'does not match any currently-registered command'],
    fix: 'the stale-allowlist branch of scripts/check-command-reachability.mjs stopped firing — an allowlist that never expires is an allowlist that hides dead commands forever.',
  },
  {
    gate: 'platform-discipline',
    id: 'unsanctioned-tauri-import',
    seeded: "created src/redproof-sentinel-tauri.ts importing '@tauri-apps/api/core'",
    claim: "a '@tauri-apps/*' import outside src/lib/platform/** must fail unless allowlisted",
    inject: (wt) =>
      seed.write(
        wt,
        'src/redproof-sentinel-tauri.ts',
        `${SENTINEL_HEADER}import { invoke } from '@tauri-apps/api/core';\nexport const probe = invoke;\n`,
      ),
    expect: ['src/redproof-sentinel-tauri.ts', "imports '@tauri-apps/*'"],
    fix: 'TAURI_IMPORT_RE or the walk() scope in scripts/check-platform-discipline.mjs no longer sees a plain static import — the platform boundary is unguarded.',
  },
  {
    gate: 'platform-discipline',
    id: 'stale-allowlist-entry',
    seeded:
      'added a nonexistent file to the allowed[] list in scripts/platform-discipline-allowlist.json',
    claim: 'an allowlisted file that no longer imports @tauri-apps must fail as stale',
    inject: (wt) =>
      seed.json(wt, 'scripts/platform-discipline-allowlist.json', (data) => {
        data.allowed.push('src/redproof-sentinel-stale-allowlist.ts');
      }),
    expect: ['src/redproof-sentinel-stale-allowlist.ts', 'no longer imports'],
    fix: 'the stale-entry branch of scripts/check-platform-discipline.mjs stopped firing — the ratchet toward zero direct Tauri access is no longer being held.',
  },
  {
    gate: 'drift-check',
    id: 'new-unregistered-copy',
    seeded:
      'created src/redproof-sentinel-server-url.ts defining validateSyncServerUrl() (a registered concept)',
    claim: "deny-by-default: a NEW file matching a registered concept's scan pattern must fail",
    inject: (wt) =>
      seed.write(
        wt,
        'src/redproof-sentinel-server-url.ts',
        `${SENTINEL_HEADER}export function validateSyncServerUrl(url: string): string {\n  return url;\n}\n`,
      ),
    expect: [
      '[validate-server-url]',
      'NEW unregistered occurrence',
      'src/redproof-sentinel-server-url.ts',
    ],
    fix: "the scan block for 'validate-server-url' in scripts/drift-registry.json no longer detects a fresh copy (wrong dirs/extensions/pattern), or scripts/drift-check.mjs stopped scanning. Deny-by-default is the whole point of R1 — see 90a62902.",
  },
  {
    gate: 'drift-check',
    id: 'stale-registered-copy',
    seeded:
      'pointed a registry copy at src/redproof-sentinel-missing-copy.ts, which does not exist',
    claim: 'a registered copy whose file is gone must fail (the registry cannot go stale silently)',
    inject: (wt) =>
      seed.json(wt, 'scripts/drift-registry.json', (data) => {
        data.entries[0].copies.push({
          location: 'src/redproof-sentinel-missing-copy.ts',
          pattern: 'redproofSentinel',
        });
      }),
    expect: ["registered copy 'src/redproof-sentinel-missing-copy.ts' does not exist"],
    fix: 'scripts/drift-check.mjs stopped validating that registered copies exist — a moved file would silently drop out of the watchlist (54d1cc41).',
  },
  {
    gate: 'agent-docs',
    id: 'broken-just-recipe',
    seeded: 'added `just redproof-sentinel-no-such-recipe` to README.md',
    claim: 'a `just <recipe>` reference with no matching justfile recipe must fail',
    inject: (wt) =>
      seed.append(wt, 'README.md', '\nSeeded: `just redproof-sentinel-no-such-recipe`.\n'),
    expect: ['README.md', 'just redproof-sentinel-no-such-recipe — no such justfile recipe'],
    fix: 'parseJustRecipes()/extractReferences() in scripts/check-agent-docs.mjs stopped seeing inline-backtick just references — agents follow these files literally, so a stale command sends them down a dead end.',
  },
  {
    gate: 'agent-docs',
    id: 'broken-pnpm-script',
    seeded: 'added `pnpm run redproof-sentinel-no-such-script` to README.md',
    claim: 'a `pnpm run <script>` reference with no matching package.json script must fail',
    inject: (wt) =>
      seed.append(wt, 'README.md', '\nSeeded: `pnpm run redproof-sentinel-no-such-script`.\n'),
    expect: [
      'README.md',
      'pnpm run redproof-sentinel-no-such-script — no such package.json script',
    ],
    fix: 'parsePackageScripts()/extractReferences() in scripts/check-agent-docs.mjs stopped validating pnpm references.',
  },
  {
    gate: 'agent-docs',
    id: 'broken-repo-path',
    seeded: 'added a `src/…` path reference to README.md that does not resolve',
    claim: 'a repo-path reference that does not exist must fail',
    inject: (wt) =>
      seed.append(wt, 'README.md', '\nSeeded: `src/redproof-sentinel-missing-path.ts`.\n'),
    expect: ['README.md', 'src/redproof-sentinel-missing-path.ts — path does not exist'],
    absent: ['no such justfile recipe'],
    fix: 'extractPathCandidate()/makePathExists() in scripts/check-agent-docs.mjs got loose enough to resolve anything — check the fallback chain (gitignore, skill-relative, prefix) for an over-broad match.',
  },
  {
    gate: 'agent-docs',
    id: 'tracked-dangling-skill-link',
    seeded:
      'committed .claude/skills/redproof-sentinel-skill as a symlink into the gitignored .agents/',
    claim:
      'a TRACKED symlink under .claude/skills/ pointing at untracked content must fail — it ' +
      'dangles in every fresh clone and git worktree (MR !207 shipped 22 of them)',
    inject: (wt) => {
      const link = path.join(wt, '.claude/skills/redproof-sentinel-skill');
      fs.symlinkSync('../../.agents/skills/redproof-sentinel-skill', link);
      // `git add` is what makes this the real violation: an untracked local link
      // is legitimate (that is what `just skills-link` creates), so the proof has
      // to stage it or it is testing the wrong thing.
      gitOrThrow(['add', '--force', '.claude/skills/redproof-sentinel-skill'], wt);
    },
    expect: ['.claude/skills/redproof-sentinel-skill', 'fresh clone'],
    absent: ['no such justfile recipe'],
    fix: 'validateSkillLinks()/listSkillEntries() in scripts/check-agent-docs.mjs stopped stat-ing skill symlinks — a committed link into a gitignored directory loads in exactly one checkout and is dead everywhere else.',
  },
  {
    gate: 'theme-single-pace',
    id: 'css-transition-over-a-theme-colour',
    seeded:
      'created src/styles/redproof-sentinel-theme.css transitioning background-color at a themed rest value',
    claim:
      'a CSS transition covering a theme-dependent property whose rest value is a real colour must fail — that is the desktop half of the law 55478cfc fixed',
    inject: (wt) =>
      seed.write(
        wt,
        'src/styles/redproof-sentinel-theme.css',
        '/* Seeded by scripts/gate-redproofs.mjs inside a throwaway git worktree. */\n' +
          '.redproof-sentinel-themed {\n' +
          '  background-color: var(--color-surface);\n' +
          '  transition: background-color 0.15s ease;\n' +
          '}\n',
      ),
    expect: [
      'src/styles/redproof-sentinel-theme.css',
      '.redproof-sentinel-themed',
      'background-color',
    ],
    absent: ['TopAppBar'],
    fix: 'the CSS half of scripts/check-theme-single-pace.mjs stopped seeing themed transitions — RULE_BLOCK_RE, THEME_PROPERTIES or restValue() drifted. Desktop theme swaps can flicker again (55478cfc).',
  },
  {
    gate: 'theme-single-pace',
    id: 'compose-topappbar-outside-the-wrapper',
    seeded: 'created a Compose screen calling Material3 TopAppBar directly',
    claim:
      "a raw Material3 TopAppBar in app code must fail — M3 springs the bar's container colour through animateColorAsState while the rest of the screen snaps",
    inject: (wt) =>
      seed.write(
        wt,
        'apps/android/app/src/main/java/com/futo/notes/ui/RedproofSentinelScreen.kt',
        '// Seeded by scripts/gate-redproofs.mjs inside a throwaway git worktree.\n' +
          'package com.futo.notes.ui\n\n' +
          'fun redproofSentinelBar() {\n' +
          '    TopAppBar(title = {})\n' +
          '}\n',
      ),
    expect: ['RedproofSentinelScreen.kt', 'TopAppBar', 'FutoTopBar'],
    absent: ['redproof-sentinel-theme.css'],
    fix: 'the Compose half of scripts/check-theme-single-pace.mjs stopped seeing direct TopAppBar calls — TOP_APP_BAR_CALL_RE or the walk() scope drifted. A fifth Android top bar can reintroduce the theme-swap spring.',
  },
  {
    gate: 'theme-single-pace',
    id: 'swiftui-preferredcolorscheme-applies-the-theme',
    seeded: 'created a SwiftUI view applying the theme with .preferredColorScheme',
    claim:
      'applying the theme as a SwiftUI preference rather than a window trait must fail — it never reaches an already-presented sheet, which then keeps its old appearance for good',
    inject: (wt) =>
      seed.write(
        wt,
        'apps/ios/Sources/App/RedproofSentinelTheme.swift',
        '// Seeded by scripts/gate-redproofs.mjs inside a throwaway git worktree.\n' +
          'import SwiftUI\n\n' +
          'struct RedproofSentinelTheme: View {\n' +
          '    var body: some View {\n' +
          '        Text("seeded").preferredColorScheme(.dark)\n' +
          '    }\n' +
          '}\n',
      ),
    expect: ['RedproofSentinelTheme.swift', 'preferredColorScheme', 'appearanceOverride'],
    absent: ['TopAppBar'],
    fix: 'the SwiftUI half of scripts/check-theme-single-pace.mjs stopped seeing .preferredColorScheme. Measured on iOS 26: with it, tapping Light/Dark left the open Settings sheet unchanged for all 468 recorded frames.',
  },
  {
    gate: 'theme-single-pace',
    id: 'wrapper-loses-its-transparent-container',
    seeded: "changed FutoTopBar's containerColor away from Color.Transparent",
    claim:
      "the wrapper losing its constant container colour must fail — the transparent container is the only reason M3's animateColorAsState has nothing to animate",
    inject: (wt) =>
      seed.replace(
        wt,
        'apps/android/app/src/main/java/com/futo/notes/ui/components/FutoTopBar.kt',
        'containerColor = Color.Transparent',
        'containerColor = FutoTheme.colors.surface',
      ),
    expect: ['FutoTopBar.kt', 'Color.Transparent'],
    absent: ['redproof-sentinel-theme.css'],
    marker: 'claim',
    fix: 'the wrapper-integrity check in scripts/check-theme-single-pace.mjs stopped firing. Routing every bar through FutoTopBar buys nothing if the wrapper itself can go back to a themed container colour.',
  },
  {
    gate: 'qa-input-safety',
    id: 'os-input-technique-in-an-instruction-file',
    seeded: "added the incident's own AppleScript keystroke recipe to README.md",
    claim:
      "an instruction surface teaching OS-level input into this app must fail — that recipe put real Cmd+Z into the user's production vault",
    inject: (wt) =>
      seed.append(
        wt,
        'README.md',
        '\nSeeded: `osascript -e \'tell application "System Events" to tell (first application ' +
          'process whose unix id is 4321) to keystroke "z" using {command down}\'`.\n',
      ),
    expect: [
      'README.md',
      'system-events-ui-scripting',
      'unix-id-process-lookup',
      'applescript-keystroke',
    ],
    absent: ['stale entry'],
    fix: 'the RULES table in scripts/check-qa-input-safety.mjs no longer matches the recorded incident shape, or collectInstructionFiles() stopped scanning README.md. Agents follow these files literally — this exact recipe is how a QA agent reached /Applications/FUTO Notes.app on the real vault (M24).',
  },
  {
    gate: 'qa-input-safety',
    id: 'process-name-lookup-against-the-app',
    seeded: 'added a `pgrep -f "futo-notes-tauri"` lookup to README.md',
    claim: 'a name/PID lookup against a binary name every build shares must fail',
    inject: (wt) =>
      seed.append(wt, 'README.md', '\nSeeded: `PID=$(pgrep -f "futo-notes-tauri" | tail -1)`.\n'),
    expect: ['README.md', 'app-process-name-lookup', 'qa-target.mjs'],
    absent: ['system-events-ui-scripting'],
    fix: 'the app-process-name-lookup rule stopped firing. Without it an instruction file can again teach a lookup that cannot distinguish the installed release app from a QA build.',
  },
  {
    gate: 'qa-input-safety',
    id: 'toolchain-pattern-kill',
    seeded: 'added a `pkill -f "cargo tauri dev"` cleanup step to README.md',
    claim:
      "a pattern kill against this repo's toolchain must fail — six worktrees share every process name, so it is machine-wide",
    inject: (wt) =>
      seed.append(
        wt,
        'README.md',
        '\nSeeded: clean up afterwards with `pkill -f "cargo tauri dev"`.\n',
      ),
    expect: ['README.md', 'process-name-kill', 'qa-target kill'],
    // The app binary is a DIFFERENT rule's territory; if this fires too, the two
    // rules have stopped being complementary and every line needs two exceptions.
    absent: ['app-process-name-lookup'],
    fix: "the process-name-kill rule stopped firing (or KILL_BY_PATTERN in scripts/check-qa-input-safety.mjs stopped recognising a kill in command position). Without it an instruction file can again teach the cleanup step that orphaned three peer worktrees' builds on 2026-08-19 — silently, as a wrong answer rather than an error.",
  },
  {
    gate: 'qa-input-safety',
    id: 'unpinned-pattern-kill-in-the-justfile',
    seeded: 'added a recipe with an unpinned `pkill -f vite` to the justfile',
    claim:
      'the justfile is scanned too: `deploy-deb`/`deploy-rpm` are pinned exceptions, and a THIRD pattern kill beside them must still fail',
    inject: (wt) =>
      seed.append(
        wt,
        'justfile',
        '\n# Seeded by scripts/gate-redproofs.mjs — delete this recipe.\nredproof-sentinel-cleanup:\n  pkill -f vite\n',
      ),
    expect: ['justfile', 'process-name-kill', 'pkill -f vite'],
    absent: ['stale entry'],
    fix: 'collectInstructionFiles() in scripts/check-qa-input-safety.mjs stopped scanning the root justfile. AGENTS.md imports it (`@justfile`), so it is instruction every agent reads — and it is where the two legitimate pattern kills live, which is exactly why a new one must not be able to hide beside them.',
  },
  {
    gate: 'qa-input-safety',
    id: 'new-occurrence-in-an-allowlisted-file',
    seeded: 'added a fresh `cliclick` line to AGENTS.md, which has a pinned cliclick exception',
    claim:
      'the allowlist pins EXACT lines, so a new occurrence in an allowlisted file is still a violation',
    inject: (wt) => seed.append(wt, 'AGENTS.md', '\nSeeded: `cliclick c:400,300` on the app.\n'),
    expect: ['AGENTS.md', 'cliclick', 'cliclick c:400,300'],
    absent: ['stale entry'],
    fix: 'applyAllowlist() in scripts/check-qa-input-safety.mjs went from pinning exact lines to whitelisting whole files — which would let the banned technique back into the very files that document the ban.',
  },
  {
    gate: 'qa-input-safety',
    id: 'stale-allowlist-entry',
    seeded: 'pinned a line to scripts/qa-input-safety-allowlist.json that appears nowhere',
    claim: 'a pinned exception that no longer exists must fail, so the allowlist cannot rot',
    inject: (wt) =>
      seed.json(wt, 'scripts/qa-input-safety-allowlist.json', (data) => {
        data.allowed['README.md'] = [
          { rule: 'cliclick', line: 'redproof-sentinel-cliclick-line', reason: 'seeded' },
        ];
      }),
    expect: ['stale entry for README.md', 'redproof-sentinel-cliclick-line'],
    fix: 'the stale-entry pass of applyAllowlist() stopped firing — an allowlist that never expires quietly grows permission for techniques nobody re-reviewed.',
  },
  {
    gate: 'qa-input-safety',
    id: 'relative-newermt-safety-check',
    seeded: 'added a `find … -newermt "-24 hours"` vault check to README.md',
    claim:
      'a relative -newermt check must fail: on BSD/macOS it matches nothing silently, so it reports an all-clear it never performed',
    inject: (wt) =>
      seed.append(
        wt,
        'README.md',
        '\nSeeded: `find ~/Documents/futo-notes -newermt "-24 hours"`.\n',
      ),
    expect: ['README.md', 'relative-newermt', 'touch -t'],
    absent: ['cliclick'],
    fix: "the relative-newermt rule stopped firing. This is the check that produced the incident's false all-clear on the user's vault — a safety check that cannot fail is worse than none.",
  },
  {
    gate: 'spec-gaps',
    id: 'closure-probe-fires',
    seeded:
      'added a `> **Gap:**` note to docs/spec/settings.md AND the codebase evidence that makes its closure probe fire',
    claim: 'a recorded gap the codebase shows as implemented must fail, so the spec gets updated',
    // BOTH halves are seeded deliberately. A closure probe fires only when a gap
    // note matches AND `closed()` finds evidence in the tree, so seeding the note
    // alone can never turn one red — which is exactly how this proof shipped:
    // it asserted the `iOS.* app has no Settings surface` probe that had been
    // retired (correctly — iOS grew a Settings surface) long before, so it was
    // red from the moment it merged, and its `fix:` line sent readers after a
    // probe that no longer existed. Seeding the evidence too makes the proof
    // exercise the PROBES mechanism instead of depending on whichever real gap
    // happens to be open.
    inject: (wt) => {
      // Assert the borrowed probe still exists BEFORE seeding, so its retirement
      // reads as `inject-failed` with instructions rather than a bare
      // `marker-missing` that leaves the next person guessing.
      if (!seed.read(wt, 'scripts/spec-gaps.mjs').includes(CLOSURE_PROBE_GAP_PHRASE)) {
        throw new Error(
          `no closure probe in scripts/spec-gaps.mjs matches ` +
            `${JSON.stringify(CLOSURE_PROBE_GAP_PHRASE)} — it was almost certainly retired ` +
            `when its gap closed, which is normal. Repoint the CLOSURE_PROBE_* constants in ` +
            `scripts/gate-redproofs.mjs at another live probe and the evidence its closed() ` +
            `greps for. Do not delete this proof.`,
        );
      }
      seed.append(
        wt,
        'docs/spec/settings.md',
        `\n> **Gap:** REDPROOF-SENTINEL ${CLOSURE_PROBE_GAP_PHRASE}.\n`,
      );
      seed.replace(
        wt,
        CLOSURE_PROBE_EVIDENCE_FILE,
        CLOSURE_PROBE_EVIDENCE_ANCHOR,
        `${CLOSURE_PROBE_EVIDENCE_ANCHOR}\n\n// ${CLOSURE_PROBE_EVIDENCE_VOCAB}: seeded by scripts/gate-redproofs.mjs`,
      );
    },
    expect: ['Closure probe fired for settings.md:', 'REDPROOF-SENTINEL'],
    fix: `the PROBES loop in scripts/spec-gaps.mjs stopped running, or the probe matching ${JSON.stringify(CLOSURE_PROBE_GAP_PHRASE)} no longer reports its hits. Closure probes are what stop docs/spec/ recording gaps that were fixed months ago. If that probe was retired because its gap closed, this proof throws from inject() with repointing instructions instead of reaching here.`,
  },
  {
    gate: 'spec-gaps',
    id: 'stale-gap-inventory',
    seeded: 'added a `> **Gap:**` note to docs/spec/settings.md without regenerating GAPS.md',
    claim: 'GAPS.md that no longer matches the inline gap notes must fail',
    inject: (wt) =>
      seed.append(
        wt,
        'docs/spec/settings.md',
        '\n> **Gap:** REDPROOF-SENTINEL placeholder, no closure probe matches this text.\n',
      ),
    // The gate reports staleness without echoing the gap text, so this proof
    // asserts on the gate's own claim sentence — it still separates "detected"
    // from "crashed", which is the line that matters.
    expect: ['GAPS.md is stale'],
    marker: 'claim',
    fix: 'the render()-vs-file comparison in scripts/spec-gaps.mjs --check stopped firing, or GAP_LINE_RE no longer matches a plain `> **Gap:**` line (the qualified-gap bug this regex was widened for).',
  },
  {
    gate: 'toolbar-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${TOOLBAR_SWIFT}`,
    claim: 'a generated native toolbar spec that drifts from the manifest must fail',
    inject: (wt) => seed.append(wt, TOOLBAR_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${TOOLBAR_SWIFT} is STALE`],
    absent: [`${TOOLBAR_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-toolbar-spec.ts --check stopped comparing rendered output against the file on disk — M8 (edit sources, not generated files) is unenforced for the toolbar contract.',
  },
  {
    gate: 'title-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${TITLE_SWIFT}`,
    claim: 'a generated native title spec that drifts from the manifest must fail',
    inject: (wt) => seed.append(wt, TITLE_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${TITLE_SWIFT} is STALE`],
    absent: [`${TITLE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-title-spec.ts --check stopped comparing rendered output against the file on disk.',
  },
  {
    gate: 'title-spec',
    id: 'manifest-changed-without-regenerating',
    seeded: 'changed MAX_TITLE_LENGTH in packages/editor/src/filename.ts without regenerating',
    claim: 'a manifest change that is not propagated to BOTH native specs must fail',
    inject: (wt) =>
      seed.replace(
        wt,
        'packages/editor/src/filename.ts',
        'export const MAX_TITLE_LENGTH = 200;',
        'export const MAX_TITLE_LENGTH = 201;',
      ),
    // Both hosts must be reported — a gate that only noticed one would leave
    // the other platform silently out of sync (M10).
    expect: [`${TITLE_SWIFT} is STALE`, `${TITLE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'the manifest → generated-spec direction is unguarded: a title-rule change can ship to one native host and not the other. Check the TARGETS loop in scripts/gen-title-spec.ts.',
  },
  {
    gate: 'title-spec',
    id: 'swift-control-range-lock',
    seeded: 'expanded the canonical title-control range beyond Foundation’s shortcut',
    claim:
      'a canonical control-range change must not leave the generated Swift filter silently green',
    inject: (wt) =>
      seed.replace(wt, 'packages/editor/src/filename.ts', '[0x007f, 0x009f],', '[0x007f, 0x00a0],'),
    expect: [
      'TitleSpec.swift uses Foundation .controlCharacters; update its template for the changed canonical control ranges.',
    ],
    marker: 'claim',
    fix: 'the Swift title filter is no longer locked to FORBIDDEN_TITLE_CONTROL_RANGES; restore the generator’s Foundation-range assertion or derive the Swift set directly.',
  },
  {
    gate: 'bridge-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${BRIDGE_SWIFT}`,
    claim: 'a generated native bridge spec that drifts from bridge.ts must fail',
    inject: (wt) => seed.append(wt, BRIDGE_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${BRIDGE_SWIFT} is STALE`],
    absent: [`${BRIDGE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-bridge-spec.ts --check stopped comparing rendered output against the file on disk — BRIDGE_VERSION and the outbound message list can drift from the native hosts.',
  },
  {
    gate: 'rust-dependency-boundaries',
    id: 'portable-crate-reaches-tantivy',
    seeded: 'added tantivy to crates/futo-notes-core/Cargo.toml (+ refreshed Cargo.lock offline)',
    claim: 'a portable core crate that reaches a search/ML dependency must fail',
    inject: (wt) => {
      seed.replace(
        wt,
        'crates/futo-notes-core/Cargo.toml',
        '[dependencies]\n',
        '[dependencies]\ntantivy = "0.26"\n',
      );
      // A real MR adding this dependency would also commit the lock update;
      // without it `cargo metadata --locked` dies before the gate's own logic
      // runs, which would be a crash, not a detection.
      const refresh = spawnSync('cargo', ['metadata', '--offline', '--format-version=1'], {
        cwd: wt,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (refresh.status !== 0) {
        throw new Error(
          `could not refresh Cargo.lock offline (is tantivy in the local cargo registry cache?):\n${refresh.stderr ?? refresh.error?.message ?? ''}`,
        );
      }
    },
    expect: ['futo-notes-core reaches tantivy'],
    fix: 'scripts/check-rust-dependency-boundaries.mjs stopped walking the resolve graph — the dep-guard that keeps tantivy/ort out of the portable crates (and out of the native FFI facade) is not enforcing anything.',
  },
];

// ---------------------------------------------------------------------------
// Harness self-test — proves the harness itself cannot go green vacuously
//
// Runs the SAME green/red machinery over fixture "gates" whose behavior is
// known, and asserts the verdict code. If the harness ever starts calling a
// gate that never fails, or one that fails without naming the violation, a
// PASS here, the self-test fails and the whole run is red.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = 'scripts/__fixtures__/gate-redproofs';
const FIXTURE_SENTINEL = `${FIXTURE_DIR}/seeded-violation`;

function fixtureGate(name) {
  return ['node', [`${FIXTURE_DIR}/${name}`]];
}

const SELF_TESTS = [
  {
    id: 'vacuous-green-gate-is-rejected',
    why: 'a gate that always exits 0 must never be reported as working',
    gate: fixtureGate('vacuous-green-gate.mjs'),
    expectCode: 'gate-not-red',
  },
  {
    id: 'exit-code-only-is-rejected',
    why: 'a gate that exits non-zero WITHOUT naming the violation (a crash) must not count',
    gate: fixtureGate('crashing-gate.mjs'),
    expectCode: 'marker-missing',
  },
  {
    id: 'already-red-gate-is-rejected',
    why: 'a gate that is red on a pristine checkout makes its own red-proof vacuous',
    gate: fixtureGate('always-red-gate.mjs'),
    expectCode: 'green-not-clean',
  },
  {
    id: 'honest-gate-passes',
    why: 'the machinery must still accept a gate that genuinely detects and reports',
    gate: fixtureGate('honest-gate.mjs'),
    expectCode: 'ok',
  },
];

const SELF_TEST_PROOF = {
  seeded: `created ${FIXTURE_SENTINEL}`,
  inject: (wt) => seed.write(wt, FIXTURE_SENTINEL, 'redproof-selftest-violation\n'),
  expect: ['redproof-selftest-violation-detected'],
};

// ---------------------------------------------------------------------------
// Worktree plumbing
// ---------------------------------------------------------------------------

// maxBuffer: `ls-files --others` enumerates EVERY untracked file, and CI
// restores $CI_PROJECT_DIR/.pnpm-store (not gitignored) into the build dir —
// a pnpm content-addressable store is ~25 MB of path text, 25x Node's 1 MB
// default. On overflow spawnSync SIGTERMs git and returns status=null with an
// empty stderr, which used to surface as a blank "git ... failed:".
function git(args, cwd = ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOrThrow(args, cwd = ROOT) {
  const result = git(args, cwd);
  if (result.status !== 0) {
    // `||`, not `??`: an empty stderr must fall through to error.message, or a
    // spawn-level failure (ENOBUFS, ENOENT) reports its reason as nothing at all.
    const reason =
      result.stderr || result.error?.message || `exited with signal ${result.signal ?? 'unknown'}`;
    throw new Error(`git ${args.join(' ')} failed:\n${reason}`);
  }
  return result.stdout.trim();
}

// The commit the proof worktree is built from: the working tree's tracked
// state when it is dirty (so a gate you just edited is the one under test),
// HEAD when it is clean. Untracked files are never included — reported, not
// hidden.
function resolveBase() {
  const head = gitOrThrow(['rev-parse', '--short', 'HEAD']);
  const status = gitOrThrow(['status', '--porcelain']).split('\n').filter(Boolean);
  const trackedEdits = status.some((line) => !line.startsWith('??'));
  const untracked = gitOrThrow(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean);

  if (!trackedEdits) return { rev: head, label: `HEAD ${head}`, untracked };

  const stash = git(['stash', 'create']);
  const rev = stash.status === 0 ? stash.stdout.trim() : '';
  if (!rev) {
    return {
      rev: head,
      label: `HEAD ${head} — the working tree has tracked edits but 'git stash create' produced nothing, so those edits are NOT covered`,
      untracked,
    };
  }
  return {
    rev,
    label: `working tree of HEAD ${head} (via git stash create ${rev.slice(0, 9)})`,
    untracked,
  };
}

function createWorktree(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-gate-redproof-'));
  const wt = path.join(dir, 'wt');
  gitOrThrow(['worktree', 'add', '--detach', wt, rev]);
  // tsx-based gates need the workspace's installed toolchain. A symlink is
  // enough: every gate walker skips a directory named node_modules, and it is
  // gitignored so `git clean` leaves it alone.
  const realModules = path.join(ROOT, 'node_modules');
  if (fs.existsSync(realModules)) fs.symlinkSync(realModules, path.join(wt, 'node_modules'));
  return { dir, wt };
}

// No `git worktree prune` here: `remove --force` already deregisters this
// worktree, and a blanket prune would also deregister every OTHER worktree
// whose directory has since vanished (this repo carries agent scratchpads
// under /tmp) — a side effect a throwaway proof worktree has no business having.
function destroyWorktree({ dir, wt }) {
  git(['worktree', 'remove', '--force', wt]);
  fs.rmSync(dir, { recursive: true, force: true });
}

// `.gitignore` lists `node_modules/` as a DIRECTORY pattern, and the
// toolchain link this harness drops in is a symlink — which git sees as a
// file, reports as untracked, and would fail the cleanliness assertion below.
const IGNORED_IN_PROOF_WORKTREE = new Set(['node_modules']);

function revert(wt) {
  // Unstage first: a proof whose violation only exists once git TRACKS the path
  // (a committed symlink, say) has to `git add` it, and neither `checkout` nor
  // `clean` touches the index — the staged entry would survive into the next
  // proof and trip the cleanliness assertion below.
  gitOrThrow(['reset', '-q'], wt);
  gitOrThrow(['checkout', '--', '.'], wt);
  gitOrThrow(['clean', '-fdq', '-e', 'node_modules'], wt);
  const leftover = gitOrThrow(['status', '--porcelain'], wt)
    .split('\n')
    .filter((line) => line !== '' && !IGNORED_IN_PROOF_WORKTREE.has(line.slice(3).trim()))
    .join('\n');
  if (leftover !== '') {
    throw new Error(
      `proof worktree did not revert cleanly — later proofs would run against contaminated state:\n${leftover}`,
    );
  }
}

function runGate(wt, [command, args]) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: wt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    spawnError: result.error ? result.error.message : null,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// The two directions
// ---------------------------------------------------------------------------

function proveGreen(wt, gate) {
  const run = runGate(wt, gate);
  if (run.spawnError) {
    return { code: 'green-spawn-failed', detail: run.spawnError, ms: run.ms };
  }
  if (run.status !== 0) {
    return { code: 'green-not-clean', detail: tail(run.output), ms: run.ms };
  }
  return { code: 'ok', detail: null, ms: run.ms };
}

function proveRed(wt, gate, proof) {
  const expected = typeof proof.expect === 'function' ? proof.expect(wt) : proof.expect;
  try {
    proof.inject(wt);
  } catch (error) {
    revert(wt);
    return { code: 'inject-failed', detail: error.message, ms: 0, expected };
  }

  const run = runGate(wt, gate);
  revert(wt);

  if (run.spawnError) {
    return { code: 'red-spawn-failed', detail: run.spawnError, ms: run.ms, expected };
  }
  if (run.status === 0) {
    return { code: 'gate-not-red', detail: tail(run.output), ms: run.ms, expected };
  }
  const missing = expected.filter((needle) => !run.output.includes(needle));
  if (missing.length > 0) {
    return {
      code: 'marker-missing',
      detail: `output never mentioned ${missing.map((m) => JSON.stringify(m)).join(', ')}\n${tail(run.output)}`,
      ms: run.ms,
      expected,
    };
  }
  const forbidden = (proof.absent ?? []).filter((needle) => run.output.includes(needle));
  if (forbidden.length > 0) {
    return {
      code: 'marker-forbidden',
      detail: `output also reported ${forbidden.map((m) => JSON.stringify(m)).join(', ')} — the gate is failing indiscriminately, not detecting this violation\n${tail(run.output)}`,
      ms: run.ms,
      expected,
    };
  }
  return { code: 'ok', detail: null, ms: run.ms, expected };
}

function tail(text, lines = 8) {
  const trimmed = text.trim();
  if (trimmed === '') return '(no output at all)';
  return trimmed
    .split('\n')
    .slice(-lines)
    .map((line) => `      | ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const REMEDIATION = {
  'green-spawn-failed':
    'the gate could not be launched in a fresh checkout. Run `pnpm install` (tsx gates need node_modules), then re-run.',
  'green-not-clean':
    'the gate is ALREADY red on a pristine checkout, so its red-proof would prove nothing. Fix the violation the gate is reporting (above), or fix the gate. ' +
    'If the gate names a path that DOES exist in your working tree, check the NOT PROVED line above: the proof worktree is built from tracked state, so a new file you have not `git add`ed is absent there and reads as a broken reference.',
  'inject-failed':
    'the seeded violation could not be applied — the file or literal this proof edits moved. Update the proof in scripts/gate-redproofs.mjs so it seeds the same violation against the current code.',
  'red-spawn-failed': 'the gate could not be launched. Run `pnpm install`, then re-run.',
  'gate-not-red':
    'the gate PASSED over a real seeded violation. It is protecting nothing. Do not weaken this proof to make it green.',
  'marker-missing':
    'the gate exited non-zero but never named the seeded violation — that is a crash or an unrelated failure, not a detection. Exit code alone is not proof.',
  'marker-forbidden':
    'the gate reported violations it should not have, so a non-zero exit here does not mean it found THIS one.',
};

function report(kind, name, result, extra = {}) {
  if (result.code === 'ok') {
    const marker = extra.marker ? `  [${extra.marker} marker]` : '';
    console.log(`  ok    ${name.padEnd(52)} ${String(result.ms).padStart(5)}ms${marker}`);
    return true;
  }
  console.log(`  FAIL  ${name.padEnd(52)} ${String(result.ms).padStart(5)}ms  (${result.code})`);
  if (extra.seeded) console.log(`        seeded: ${extra.seeded}`);
  if (extra.claim) console.log(`        claim:  ${extra.claim}`);
  if (result.expected) {
    console.log(
      `        wanted: output containing ${result.expected.map((m) => JSON.stringify(m)).join(', ')}`,
    );
  }
  if (result.detail) console.log(`        got:\n${result.detail}`);
  console.log(`        why:    ${REMEDIATION[result.code] ?? 'unexpected harness state.'}`);
  if (extra.fix) console.log(`        fix:    ${extra.fix}`);
  console.log('');
  return false;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function runSelfTest(wt) {
  console.log('SELF-TEST (the harness must reject a gate that cannot detect anything)');
  let failures = 0;
  for (const testCase of SELF_TESTS) {
    const green = proveGreen(wt, testCase.gate);
    const actual =
      green.code !== 'ok' ? green.code : proveRed(wt, testCase.gate, SELF_TEST_PROOF).code;
    if (actual === testCase.expectCode) {
      console.log(`  ok    ${testCase.id.padEnd(52)} verdict '${actual}'`);
      continue;
    }
    failures++;
    console.log(
      `  FAIL  ${testCase.id.padEnd(52)} verdict '${actual}', wanted '${testCase.expectCode}'`,
    );
    console.log(`        why:    ${testCase.why}`);
    console.log(
      '        fix:    the harness engine in scripts/gate-redproofs.mjs no longer classifies this case correctly. ' +
        'Until it does, every "ok" it prints for a real gate is unearned — fix proveGreen()/proveRed() before trusting any other line of this report.',
    );
    console.log('');
  }
  console.log('');
  return failures;
}

function main() {
  const argv = process.argv.slice(2);
  const selfTestOnly = argv.includes('--self-test');
  const includeCargo = argv.includes('--include-cargo');

  // Inside the try: a plumbing failure here (git refusing, a spawn overflowing)
  // must surface as the ABORTED harness report below, never as a bare stack
  // trace that reads like a crash of unknown consequence.
  let worktree = null;
  let failures = 0;

  try {
    const base = resolveBase();
    worktree = createWorktree(base.rev);
    const started = Date.now();

    console.log('Gate red-proof harness — every guard must actually fail on its own violation.');
    console.log(`  proving: ${base.label}`);
    console.log(`  worktree: ${worktree.wt}`);
    if (base.untracked.length > 0) {
      console.log(
        `  NOT PROVED: ${base.untracked.length} untracked file(s) are absent from the proof worktree ` +
          `(git add them to include): ${base.untracked.slice(0, 5).join(', ')}${base.untracked.length > 5 ? ', …' : ''}`,
      );
    }
    console.log('');

    failures += runSelfTest(worktree.wt);
    if (selfTestOnly) return failures;

    const skipped = [];
    const gateNames = Object.keys(GATES).filter((name) => {
      if (CARGO_GATES.has(name) && !includeCargo) {
        skipped.push({
          gate: name,
          why: 'needs a Rust toolchain, and CI runs the portable arch-gate in an image without cargo. Re-run with --include-cargo (`just gate-redproofs` does).',
        });
        return false;
      }
      return true;
    });

    console.log('GREEN — each gate exits 0 on a pristine checkout');
    const usable = [];
    for (const name of gateNames) {
      const result = proveGreen(worktree.wt, GATES[name]);
      if (report('green', name, result, { fix: null })) usable.push(name);
      else failures++;
    }
    console.log('');

    console.log('RED — each gate exits non-zero AND names the seeded violation');
    let redCount = 0;
    for (const proof of PROOFS) {
      if (!gateNames.includes(proof.gate)) continue;
      const name = `${proof.gate}/${proof.id}`;
      if (!usable.includes(proof.gate)) {
        console.log(`  skip  ${name.padEnd(52)}        (its GREEN direction failed above)`);
        failures++;
        continue;
      }
      redCount++;
      const result = proveRed(worktree.wt, GATES[proof.gate], proof);
      if (!report('red', name, result, proof)) failures++;
    }
    console.log('');

    if (skipped.length > 0 || NOT_COVERED.length > 0) {
      console.log(
        'NOT COVERED (stated, not assumed — a hole you cannot see is worse than one you can)',
      );
      for (const item of [...skipped, ...NOT_COVERED]) {
        console.log(`  -  ${item.gate}\n     ${item.why}`);
      }
      console.log('');
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (failures > 0) {
      console.error(
        `Gate red-proof harness FAILED — ${failures} issue(s) across ${gateNames.length} gate(s) / ${redCount} red-proof(s) in ${seconds}s.`,
      );
      console.error(
        'A failure here means a guard this repo relies on is not guarding. Fix the gate (or the proof, if the gate changed on purpose) — never delete the proof to get green.',
      );
      return failures;
    }
    console.log(
      `Gate red-proof harness OK — ${gateNames.length} gate(s) green on a pristine tree and red on ${redCount} seeded violation(s), ${seconds}s.`,
    );
    return 0;
  } catch (error) {
    // Reaching here means the plumbing broke (a seeded violation could not be
    // reverted, git refused, …). Report it as a harness failure rather than a
    // bare stack trace: a crashed harness proves nothing, and must never be
    // mistaken for a pass.
    console.error(`\nGate red-proof harness ABORTED: ${error.message}`);
    console.error(
      'The harness could not complete, so NOTHING was proved on this run. Re-run after fixing the ' +
        'above; if a proof left files behind, they live only in the throwaway worktree printed at the top.',
    );
    return 1;
  } finally {
    if (worktree) destroyWorktree(worktree);
  }
}

process.exit(main() > 0 ? 1 : 0);
