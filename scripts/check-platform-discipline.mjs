// Platform discipline gate (architecture-hardening.md PKT-7 gate 2 / F29 /
// L2-4). `lint:platform` (package.json) only greps for the strings left over
// from the removed Electron/Capacitor shells — it does not actually enforce
// "Tauri access goes through src/lib/platform/**" (AGENTS.md §5). This gate
// does: any `@tauri-apps/*` import (static `from '@tauri-apps/...'` or
// dynamic `import('@tauri-apps/...')`) outside src/lib/platform/** must be in
// the checked-in allowlist (scripts/platform-discipline-allowlist.json).
//
//   node scripts/check-platform-discipline.mjs   (just check-platform-discipline)
//
// Fails on:
//   (a) a `@tauri-apps` import outside platform/ that isn't allowlisted
//   (b) an allowlisted file that no longer imports `@tauri-apps` (stale entry)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const PLATFORM_DIR = path.join(SRC_DIR, 'lib', 'platform') + path.sep;
const ALLOWLIST_PATH = path.join(ROOT, 'scripts/platform-discipline-allowlist.json');

// Matches a quote/paren immediately before the package name — not a prose
// mention of "@tauri-apps" in a comment. Tested against the WHOLE file text
// (not line-by-line), so it catches: static named/default/namespace imports
// (`from '@tauri-apps/x'`), side-effect imports (`import '@tauri-apps/x'`,
// no `from`), CommonJS `require('@tauri-apps/x')`, and dynamic
// `import('@tauri-apps/x')` — including the type-only `import('x').Type`
// form and the case where the specifier sits on a line after `import(`
// (`\s*` spans newlines), e.g. `import(\n  '@tauri-apps/x'\n)`.
const TAURI_IMPORT_RE =
  /(?:\bimport\s*\(\s*['"]|\bfrom\s+['"]|\brequire\s*\(\s*['"]|\bimport\s+['"])@tauri-apps\//;

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = walk(SRC_DIR, ['.ts', '.svelte']).filter(
  (f) =>
    !f.endsWith('.test.ts') &&
    !f.split(path.sep).includes('__mocks__') &&
    !f.startsWith(PLATFORM_DIR),
);

const usesTauri = new Set();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (TAURI_IMPORT_RE.test(text)) {
    usesTauri.add(path.relative(ROOT, file));
  }
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowed = new Set(allowlist.allowed);

const failures = [];

for (const rel of usesTauri) {
  if (!allowed.has(rel)) {
    failures.push(
      `${rel} imports '@tauri-apps/*' but is outside src/lib/platform/** and not in the ` +
        `allowlist (${path.relative(ROOT, ALLOWLIST_PATH)}) — move the access behind the ` +
        `PlatformFS/sync/search shims, or add it with a reason if it's genuine OS glue.`,
    );
  }
}

for (const rel of allowed) {
  if (!usesTauri.has(rel)) {
    failures.push(
      `allowlisted file '${rel}' no longer imports '@tauri-apps/*' — remove it from the ` +
        `allowlist, the entry is stale.`,
    );
  }
}

if (failures.length > 0) {
  console.error('Platform discipline gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} issue(s).`);
  process.exit(1);
}

console.log(
  `Platform discipline gate OK — ${allowed.size} allowlisted OS-glue file(s), 0 unsanctioned ` +
    `'@tauri-apps' imports outside src/lib/platform/**.`,
);
