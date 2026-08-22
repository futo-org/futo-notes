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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// Retired probes (2026-07-31): each of these matched the wording of a Gap
// note that was already closed AND removed from docs/spec/*.md, so the probe
// could never again find a matching gap to watch — dead code claiming
// coverage (see the "matches zero recorded gaps" check below, which is what
// caught them). Left here as a paper trail instead of silently vanishing:
//   - "Android native has no move UI" / "no New Folder affordance" /
//     "no folder-delete UI" / "iOS…app has no Settings surface" — all four
//     closed by ba2ef7a2 ("native shells: close all 15 spec gaps").
//   - "native shells expose no folder-rename/folder-move affordance" — closed
//     by 33312c91 ("feat(folders): add rename and move actions across
//     platforms").
//   - "title places the cursor at the start of the prefilled Untitled" —
//     closed by 7d3a0bff ("feat(mobile): quick-capture notes, inline
//     tappable title, illegal-title UX").
// Retired 2026-08-11: issue #89's "KeepDraft{Diverged} rebases the baseline
// onto the pulled disk content" probe. The gap it watched is closed — the
// classifier keeps the pre-pull base and desktop's own copy no longer rebases
// — so its wording is gone from docs/spec and the probe had no gap left to
// watch. What replaces it is not a probe but assertions: the classifier's
// property test, futo-notes-ffi's classify -> flush_draft seam test, and the
// cross-platform scenario "dirty draft survives a peer edit then settles".
const PROBES = [
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
    // Was `/native shells.*no-op a broken wikilink tap/s` — born dead in
    // 12b077b7: docs/spec/editor.md:211 writes "the **native** shells", and
    // the `**` bold markers around "native" broke the "native shells"
    // substring match, so this probe had never once been able to fire.
    // Matching just the distinctive, markdown-free tail of the gap's prose
    // is both sufficient (the phrase is unique in docs/spec/*.md) and immune
    // to bold/italic markup drift around "native shells".
    match: /no-op a broken wikilink tap/,
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
  {
    // issue #79 — the iOS navigation exit ignores a parked-conflict disposition.
    // Closing it means the exit has to learn the disposition, which today's
    // `commitBody` (-> Bool) cannot carry: either EditorSession gains the
    // parked case, or NoteEditorView grows a second `editorMoveSourceId` call
    // site (it has exactly two today — the definition and the move path).
    match: /navigation exit iOS ignores a parked-conflict/,
    closed: () => {
      const session = read('apps/ios/Sources/Notes/Editor/EditorSession.swift');
      const view = read('apps/ios/Sources/Notes/Editor/NoteEditorView.swift');
      return /parkedConflict/.test(session) || view.split('editorMoveSourceId(').length - 1 > 2;
    },
    hint: 'the iOS editor session or navigation path now references the parked-conflict id — the #79 divergence may be closed.',
  },
  {
    // issue #80 — Android drops an editor change that lands mid-delete. iOS's
    // counterpart is named `quarantine`/`takeQuarantined`, so any quarantine
    // vocabulary appearing in Android's session or editor screen means the
    // buffer was added.
    match: /destructive latch is DROPPED on Android/,
    closed: () =>
      /quarantin/i.test(
        read('apps/android/app/src/main/java/com/futo/notes/ui/EditorSession.kt'),
      ) ||
      /quarantin/i.test(
        read('apps/android/app/src/main/java/com/futo/notes/ui/NoteEditorScreen.kt'),
      ),
    hint: 'Android now has quarantine vocabulary in the editor session/screen — the #80 dropped-keystroke divergence may be closed.',
  },
  {
    // search.md — both native shells trim the query tail before calling
    // store.search, so the core's mid-typing prefix rule cannot tell "Aug "
    // from "Aug". It closes when neither shell trims on the path that FEEDS
    // store.search: Android's debounced `snapshotFlow`, and the trim iOS's
    // `runSearch` passes as `q`. Both files trim elsewhere too (Android's
    // empty-state check, iOS's local list filter), which is why the regexes
    // are scoped rather than a bare grep for `.trim()`. A missing file is NOT
    // evidence of closure — a rename would otherwise fire this every run.
    match: /native shells trim the query's tail/,
    closed: () => {
      const kt = read('apps/android/app/src/main/java/com/futo/notes/ui/SearchScreen.kt');
      const swift = read('apps/ios/Sources/Notes/List/NoteListView.swift');
      if (!kt || !swift) return false;
      return (
        !/snapshotFlow \{[^}]*\.trim\(\)/.test(kt) &&
        !/trimmingCharacters[\s\S]{0,400}?store\.search\(q/.test(swift)
      );
    },
    hint: 'neither native shell trims its search query any more — the query-tail trim gap may be closed.',
  },
  {
    // editor.md — blockquotes deeper than 3 get no per-level indent because
    // the stylesheets stop at `.cm-md-quote-level-3`. Closure is visible in
    // CSS: either a level-4-or-deeper rule, or a depth-general custom property
    // replacing the hand-written per-level rules. Both stylesheets count —
    // app-shell.css's `.editor-container`-scoped padding outranks the other.
    match: /blockquotes nested four or more deep/,
    closed: () => {
      const deeperLevelRule = /cm-md-quote-level-(?:[4-9]|\d\d)/;
      const depthGeneral = /--md-quote-(?:depth|level)\b/;
      return [read('src/styles/markdown-blocks.css'), read('src/styles/app-shell.css')].some(
        (css) => deeperLevelRule.test(css) || depthGeneral.test(css),
      );
    },
    hint: 'a quote stylesheet now indents past level 3 (a level-4+ rule or a depth-general custom property) — the deep-nesting indent gap may be closed.',
  },
  {
    // editor.md — a lazy-continuation line inside a blockquote gets no quote
    // decoration because `decorateBlockQuote` bails on any line whose OWN text
    // has nest level 0. That single `continue` IS the gap, so its disappearance
    // is the closure signal. Deliberately not also grepping for "lazy": the
    // file already says "lazy continuations" in an unrelated perf comment, so
    // that clause fired on day one. A missing file is not evidence of closure.
    match: /lazy-continuation line/,
    closed: () => {
      const decorations = read('src/features/editor/live-preview/blockDecorations.ts');
      if (!decorations) return false;
      return !/if \(nestLevel === 0\) continue;/.test(decorations);
    },
    hint: 'blockDecorations.ts no longer skips nest-level-0 lines inside a quote (or has grown lazy-continuation handling) — the flush-left continuation gap may be closed.',
  },
  {
    // editor.md — the native note-OPEN path (`applyContent`) still dispatches a
    // plain transaction, so the editing filters run over text the user never
    // typed. Its sibling, the sync-adopt path, was exempted from them via
    // EXTERNAL_CONTENT_OPTS `filter: false`; the gap closes when the load path
    // is exempted too.
    match: /a load, not an adopt/,
    closed: () =>
      /applyContent\([\s\S]{0,300}?filter: false/.test(
        read('src/editor-embed/createFutoEditorApi.ts'),
      ),
    hint: 'editor-embed applyContent now exempts the note-open dispatch from the transaction filters — the native open-renumbers-the-note gap may be closed.',
  },
  // Retired 2026-08-19: the "Flatpak folder delete is permanent" gap closed as
  // specified behavior rather than being fixed — folder delete moves every note
  // to the parent first, so only the emptied shell (plus stray non-note files)
  // is hard-deleted, and the confirmation now discloses it
  // (`folderDeleteWarning`, `vault_status.folderDeletesArePermanent`). What
  // replaces the probe is the live-portal test the gap always leaned on
  // (`portal_trash_declines_a_directory`) plus the spec line in list.md.
  {
    // desktop-rust.md — a coalesced poll event can be eaten by the one-shot
    // self-write suppressor. Closing it means suppression carrying the written
    // content, so the registration signature has to grow past a bare path.
    match: /concurrent external edit can be swallowed by self-write suppression/s,
    closed: () => {
      const rs = read('apps/tauri/src-tauri/src/filesystem_watcher.rs');
      if (!rs) return false;
      return /fn register\(&self, relative_path: &str, [^)]/.test(rs);
    },
    hint: 'WatcherSuppression::register now takes more than a path — content-aware suppression may have closed the polled-vault external-edit race.',
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

// A probe whose `match` regex hits zero of the currently recorded gaps is
// watching nothing — either its target gap was closed and removed from
// docs/spec (repair by retiring the probe with a comment) or the regex never
// matched the gap's actual prose (repair by fixing the regex; the wikilink-tap
// probe above was born dead this way, broken by markdown `**bold**` markers
// around "native shells"). Either way it is dead code claiming coverage, so
// `--check` fails the gate rather than reporting it silently alongside the
// live probes.
export function findDeadProbes(probes, gaps) {
  return probes.filter((probe) => !gaps.some((g) => probe.match.test(g.text)));
}

// ── main ───────────────────────────────────────────────────────────────────

function main() {
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

    for (const probe of findDeadProbes(PROBES, gaps)) {
      console.error(
        `Closure probe matches zero recorded gaps: ${probe.match}\n` +
          `  hint: ${probe.hint}\n` +
          `  → either its gap was closed and removed (retire the probe with a comment saying so), ` +
          `or the regex no longer matches the gap's current wording (fix the regex).`,
      );
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
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
