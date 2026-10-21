// Gate red-proofs for the single-pace theme swap and QA-input safety; listed by ./proofs.mjs.

import { seed } from './seed.mjs';

export const THEME_AND_QA_INPUT_PROOFS = [
  {
    gate: 'theme-single-pace',
    id: 'css-transition-over-a-theme-color',
    seeded:
      'created src/styles/redproof-sentinel-theme.css transitioning background-color at a themed rest value',
    claim:
      'a CSS transition covering a theme-dependent property whose rest value is a real color must fail — that is the desktop half of the law 55478cfc fixed',
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
      "a raw Material3 TopAppBar in app code must fail — M3 springs the bar's container color through animateColorAsState while the rest of the screen snaps",
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
    expect: ['RedproofSentinelScreen.kt', 'TopAppBar', 'TopBar'],
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
    seeded: "changed TopBar's containerColor away from Color.Transparent",
    claim:
      "the wrapper losing its constant container color must fail — the transparent container is the only reason M3's animateColorAsState has nothing to animate",
    inject: (wt) =>
      seed.replace(
        wt,
        'apps/android/app/src/main/java/com/futo/notes/ui/components/TopBar.kt',
        'containerColor = Color.Transparent',
        'containerColor = FutoTheme.colors.surface',
      ),
    expect: ['TopBar.kt', 'Color.Transparent'],
    absent: ['redproof-sentinel-theme.css'],
    marker: 'claim',
    fix: 'the wrapper-integrity check in scripts/check-theme-single-pace.mjs stopped firing. Routing every bar through TopBar buys nothing if the wrapper itself can go back to a themed container color.',
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
    fix: "the process-name-kill rule stopped firing (or KILL_BY_PATTERN in scripts/check-qa-input-safety.mjs stopped recognizing a kill in command position). Without it an instruction file can again teach the cleanup step that orphaned three peer worktrees' builds on 2026-08-19 — silently, as a wrong answer rather than an error.",
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
];
