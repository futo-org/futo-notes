// Gap inventory tooling for docs/spec/.
//
// The inline `> **Gap:**` blockquotes in docs/spec/*.md are the single
// source of truth. This script:
//
//   --write   regenerate docs/spec/GAPS.md (the rollup view)
//   --check   fail if GAPS.md is stale vs the inline lines, run closure
//             probes (grep-level evidence that a recorded gap has been
//             implemented), and warn on gaps whose observation date is old
//
// `just spec-gaps` / `just spec-gaps-check` wrap these.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = path.join(ROOT, 'docs/spec');
const OUT = path.join(SPEC_DIR, 'GAPS.md');
const MAX_AGE_DAYS = 90;

// ── collect ────────────────────────────────────────────────────────────────

function collectGaps() {
  const gaps = [];
  const files = fs
    .readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'GAPS.md' && f !== 'README.md')
    .sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(SPEC_DIR, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*> \*\*Gap:\*\*/.test(lines[i])) continue;
      const start = i;
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        block.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      i--;
      const text = block
        .join(' ')
        .replace(/\*\*Gap:\*\*\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      gaps.push({ file, line: start + 1, text });
    }
  }
  return gaps;
}

// ── closure probes ─────────────────────────────────────────────────────────
//
// Each probe pairs a regex over the gap TEXT with a cheap static check that
// returns true when the codebase shows evidence the gap has been closed.
// Probes are heuristics: a hit means "go verify and update the spec", not
// "the spec is wrong". Add a probe whenever you record a gap that grep can
// later detect the closure of.

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function ktScreenFiles() {
  const dir = path.join(ROOT, 'apps/android/app/src/main/java');
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.kt') && e.name !== 'NotesStore.kt') out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const PROBES = [
  {
    match: /hybrid search crate is reachable only via Tauri commands/,
    closed: () => /\bsearch/i.test(read('crates/futo-notes-ffi/src/lib.rs')),
    hint: 'futo-notes-ffi/src/lib.rs now mentions search — is hybrid search exposed to the native shells?',
  },
  {
    match: /Android native has no move UI/,
    closed: () => ktScreenFiles().some((f) => /\.moveNote\(/.test(fs.readFileSync(f, 'utf8'))),
    hint: 'an Android screen now calls store.moveNote() — move UI may exist.',
  },
  {
    match: /Android native has no New Folder affordance/,
    closed: () =>
      ktScreenFiles().some((f) => /New Folder|\.createFolder\(/.test(fs.readFileSync(f, 'utf8'))),
    hint: 'an Android screen now references folder creation.',
  },
  {
    match: /Android native has no folder-delete UI/,
    closed: () =>
      ktScreenFiles().some((f) => /\.deleteFolder\(|Delete folder/i.test(fs.readFileSync(f, 'utf8'))),
    hint: 'an Android screen now references folder deletion.',
  },
  {
    match: /Tauri desktop still surfaces per-item counts/,
    closed: () =>
      !/uploaded/.test(read('src/components/SettingsScreen.svelte')) &&
      !/Synced \$\{totalChanges\} notes/.test(read('src/lib/syncManager.svelte.ts')),
    hint: 'desktop sync UI no longer formats per-item counts — the "Sync complete" gap may be closed.',
  },
  {
    match: /iOS.* app has no Settings surface/,
    closed: () =>
      fs.existsSync(path.join(ROOT, 'apps/ios/Sources')) &&
      fs.readdirSync(path.join(ROOT, 'apps/ios/Sources')).some((f) => /settings/i.test(f)),
    hint: 'apps/ios/Sources now has a Settings file.',
  },
];

// ── render ─────────────────────────────────────────────────────────────────

function render(gaps) {
  const bySurface = new Map();
  for (const g of gaps) {
    if (!bySurface.has(g.file)) bySurface.set(g.file, []);
    bySurface.get(g.file).push(g);
  }
  let md = `# Gap Inventory — GENERATED, do not edit

One line per inline \`> **Gap:**\` note in docs/spec/*.md (the source of
truth). Regenerate with \`just spec-gaps\`; \`just spec-gaps-check\` (part of
\`just check\`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

`;
  for (const [file, list] of bySurface) {
    md += `## ${file}\n\n`;
    for (const g of list) {
      md += `- [${file}:${g.line}](${file}#L${g.line}) — ${g.text}\n`;
    }
    md += '\n';
  }
  md += `_${gaps.length} gaps._\n`;
  return md;
}

// ── main ───────────────────────────────────────────────────────────────────

const mode = process.argv[2];
const gaps = collectGaps();

if (mode === '--write') {
  fs.writeFileSync(OUT, render(gaps));
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${gaps.length} gaps).`);
} else if (mode === '--check') {
  let failed = false;

  const expected = render(gaps);
  const actual = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (expected !== actual) {
    console.error('GAPS.md is stale — run `just spec-gaps` and commit the result.');
    failed = true;
  }

  for (const gap of gaps) {
    for (const probe of PROBES) {
      if (probe.match.test(gap.text) && probe.closed()) {
        console.error(
          `Closure probe fired for ${gap.file}:${gap.line}\n` +
            `  gap:  ${gap.text.slice(0, 100)}…\n` +
            `  hint: ${probe.hint}\n` +
            `  → verify the behavior, then update/remove the Gap note (and run \`just spec-gaps\`).`
        );
        failed = true;
      }
    }
  }

  const today = new Date();
  for (const gap of gaps) {
    const m = gap.text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    const age = (today - new Date(`${m[0]}T00:00:00Z`)) / 86_400_000;
    if (age > MAX_AGE_DAYS) {
      console.warn(
        `note: ${gap.file}:${gap.line} was observed ${m[0]} (${Math.round(age)}d ago) — consider re-verifying.`
      );
    }
  }

  if (failed) process.exit(1);
  console.log(`Gap inventory OK (${gaps.length} gaps, ${PROBES.length} probes).`);
}
else {
  console.error('usage: node scripts/spec-gaps.mjs --write | --check');
  process.exit(2);
}
