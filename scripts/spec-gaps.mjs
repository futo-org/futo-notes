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

// Match a gap blockquote, allowing an optional parenthetical qualifier between
// "Gap" and the colon, e.g. `> **Gap:**`, `> **Gap (iOS):**`, `> **Gap
// (parity):**`. Before this, a qualified gap silently never rolled up into
// GAPS.md (it passed `spec-gaps-check` while staying invisible).
const GAP_LINE_RE = /^\s*> \*\*Gap(?:\s*\([^)]*\))?:\*\*/;
// Strip the `**Gap…:**` marker from the joined text, keeping any qualifier
// (e.g. "(iOS)") as a prefix so the rollup line still says which platform.
const GAP_STRIP_RE = /\*\*Gap(\s*\([^)]*\))?:\*\*\s*/;

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
      if (!GAP_LINE_RE.test(lines[i])) continue;
      const start = i;
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        block.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      i--;
      const text = block
        .join(' ')
        .replace(GAP_STRIP_RE, (_m, q) => (q ? q.trim() + ' ' : ''))
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
      // Skip generated UniFFI bindings: these closure probes look for
      // hand-written UI affordances, and a generated binding mirrors every FFI
      // method name (e.g. `renameFolder`), which would falsely report a
      // UI-affordance gap as closed the moment the vault exposes that verb.
      if (e.isDirectory()) {
        if (e.name !== 'uniffi') walk(p);
      } else if (e.name.endsWith('.kt') && e.name !== 'NotesStore.kt') out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const PROBES = [
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
      ktScreenFiles().some((f) =>
        /\.deleteFolder\(|Delete folder/i.test(fs.readFileSync(f, 'utf8')),
      ),
    hint: 'an Android screen now references folder deletion.',
  },
  {
    match: /native shells expose no folder-rename affordance/,
    closed: () =>
      /renameFolder|Rename Folder/i.test(read('apps/ios/Sources/NoteListView.swift')) ||
      ktScreenFiles().some((f) => /renameFolder|Rename folder/i.test(fs.readFileSync(f, 'utf8'))),
    hint: 'a native shell now references folder rename — the folder-rename gap may be closed.',
  },
  {
    match: /native shells .* expose no folder-move affordance/,
    closed: () =>
      /moveFolder|Move Folder/i.test(read('apps/ios/Sources/NoteListView.swift')) ||
      ktScreenFiles().some((f) => /moveFolder|Move folder/i.test(fs.readFileSync(f, 'utf8'))),
    hint: 'a native shell now references folder move — the folder-move gap may be closed.',
  },
  {
    match: /iOS.* app has no Settings surface/,
    closed: () =>
      fs.existsSync(path.join(ROOT, 'apps/ios/Sources')) &&
      fs.readdirSync(path.join(ROOT, 'apps/ios/Sources')).some((f) => /settings/i.test(f)),
    hint: 'apps/ios/Sources now has a Settings file.',
  },
  {
    match: /title places the cursor at the start of the prefilled "Untitled"/,
    closed: () =>
      /TextFieldValue|TextRange|selectAll/.test(
        read('apps/android/app/src/main/java/com/futo/notes/ui/NoteEditorScreen.kt'),
      ),
    hint: 'NoteEditorScreen.kt now manages the title selection — the prefill may be select-all’d.',
  },
  {
    match: /sync live pull.*land above the viewport|reloadAsync.*no at-top re-pin/s,
    closed: () =>
      /requestScrollToItem/.test(
        read('apps/android/app/src/main/java/com/futo/notes/NotesStore.kt'),
      ) ||
      /requestScrollToItem/.test(
        read('apps/android/app/src/main/java/com/futo/notes/SyncManager.kt'),
      ),
    hint: 'the Android sync-pull path now references an at-top re-pin — the live-pull anchoring gap may be closed.',
  },
  {
    match: /native shells.*no-op a broken wikilink tap/s,
    closed: () => {
      const embed = read('src/editor-embed/main.ts');
      // Today the embed posts `openNote` ONLY when `resolved !== null`; a broken
      // tap posts nothing. The gap closes when the embed acts on the broken case
      // (an else-branch post, or a create-on-missing message for the raw target).
      return (
        /resolved === null[\s\S]{0,300}?\bpost\(/.test(embed) ||
        /\b(createNote|openOrCreate\w*|createOnMissing)\b/.test(embed)
      );
    },
    hint: 'editor-embed/main.ts now appears to act on a broken wikilink tap — native create-on-broken-tap may be implemented; verify and close the gap.',
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
            `  → verify the behavior, then update/remove the Gap note (and run \`just spec-gaps\`).`,
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
        `note: ${gap.file}:${gap.line} was observed ${m[0]} (${Math.round(age)}d ago) — consider re-verifying.`,
      );
    }
  }

  if (failed) process.exit(1);
  console.log(`Gap inventory OK (${gaps.length} gaps, ${PROBES.length} probes).`);
} else {
  console.error('usage: node scripts/spec-gaps.mjs --write | --check');
  process.exit(2);
}
