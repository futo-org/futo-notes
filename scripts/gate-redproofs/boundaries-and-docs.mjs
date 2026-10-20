// Gate red-proofs for command reachability, platform discipline, the drift registry, agent docs and the coin glyph; listed by ./proofs.mjs.
import fs from 'node:fs';
import path from 'node:path';

import { seed, SENTINEL_HEADER } from './seed.mjs';
import { gitOrThrow } from './worktree.mjs';

export const BOUNDARIES_AND_DOCS_PROOFS = [
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
    fix: 'the scan block in scripts/drift-registry/validate-server-url.json no longer detects a fresh copy (wrong dirs/extensions/pattern), or scripts/drift-check.mjs stopped scanning. Deny-by-default is the whole point of R1 — see 90a62902.',
  },
  {
    gate: 'drift-check',
    id: 'stale-registered-copy',
    seeded:
      'pointed a registry copy at src/redproof-sentinel-missing-copy.ts, which does not exist',
    claim: 'a registered copy whose file is gone must fail (the registry cannot go stale silently)',
    inject: (wt) =>
      seed.json(wt, 'scripts/drift-registry/note-rules-ts-rust.json', (data) => {
        data.copies.push({
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
    fix: 'readJustCommands()/extractReferences() in scripts/check-agent-docs.mjs stopped seeing inline-backtick just references — agents follow these files literally, so a stale command sends them down a dead end.',
  },
  {
    gate: 'agent-docs',
    id: 'unreadable-justfile',
    seeded: 'imported a missing justfile',
    claim: 'a failed just metadata command must fail the gate rather than skip recipe validation',
    inject: (wt) => seed.append(wt, 'justfile', "\nimport 'redproof-sentinel-missing.just'\n"),
    expect: ['redproof-sentinel-missing.just', 'Could not find source file for import'],
    fix: 'readJustCommands() must propagate just parsing failures; never fall back to an empty recipe list.',
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
    gate: 'supporter-coin-glyph',
    id: 'one-shell-drawn-a-different-coin',
    seeded: "narrowed the diamond in Android's ic_supporter_coin.xml, leaving the other two copies",
    claim:
      'a supporter-coin copy that stops matching the derived glyph must fail — this is the exact shape of the bug that shipped a pinched figure-eight on both native shells while desktop, which draws the three.js coin over its copy, looked fine',
    inject: (wt) =>
      seed.replace(
        wt,
        'apps/android/app/src/main/res/drawable/ic_supporter_coin.xml',
        'Q24 14.1 26.489 16.589',
        'Q24 14.1 25.2 16.589',
      ),
    expect: ['ic_supporter_coin.xml', 'expected', 'actual'],
    absent: ['SupporterCoin.svelte:'],
    fix: 'scripts/check-supporter-coin-glyph.mjs stopped comparing every copy against the derived path — the coin can silently go back to being three different shapes, and only the two native shells would show it.',
  },
];
