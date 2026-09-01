# The factory: comparing our editor to Obsidian's (historical record)

**Removed 2026-08-24** (`docs/plan/scaffolding-simplification.md`). The harness lived in
`factory/`; recover the code from git history at the commit that deleted this directory if a parity
campaign restarts. This file exists so the operational knowledge does not have to be re-learned —
it is a record of how the thing worked and what it cost, not a set of live instructions.

The durable output of those campaigns is `markdown-spec/cases/` plus `tests/markdown-spec.spec.ts`,
which are untouched and remain the editor regression net.

## What it was, and why

Milkdown's ProseMirror round-trip did not fit our content model, so the Obsidian-style live-preview
editor was rebuilt on plain CodeMirror 6 (`src/features/editor/MarkdownEditor.svelte`,
`src/features/editor/liveMarkdownTransform.ts`). Obsidian was the oracle: same input, same expected
behavior. The factory drove both editors through identical scenarios, captured editor state from
each, and diffed — so parity could be pursued without hand-writing assertions.

It required a Linux host with flatpak Obsidian. Its entry point was a `/editor-parity` skill,
removed with it.

## Topology

Scenarios came from the existing `markdown-spec/cases/**.yaml` corpus, loaded through
`markdown-spec/loader.ts`. One orchestrator (`factory/judge/run.ts`) launched everything and drove
the loop against two Playwright pages:

- **Ours** — a chromium page on this worktree's Vite dev port at `/#/note/new`.
- **Obsidian** — flatpak Obsidian launched with `--remote-debugging-port=9876`, reached via
  `chromium.connectOverCDP`.

Both pages exposed the **same `window.__driver` API**, which is what made the runner
editor-agnostic: one `runOnEditor(page, markdown, events)` worked against either. Ours was
installed from a DEV-only dynamic import in `MarkdownEditor.svelte`; Obsidian's was a script
inlined in `run.ts` and evaluated in-page on connect.

The pieces:

| Path | Purpose |
|---|---|
| `factory/driver/protocol.ts` | Types for `Driver`, `DriverState`, `DriverEvent`, `DecoratedRange`, `ElementKind` |
| `factory/driver/semanticKind.ts` | Raw CSS classes → canonical `ElementKind`. Order mattered: marker classes (`cm-formatting-*`, `cm-md-inline-marker`) had to win over text classes (`cm-em`, `cm-strong`) |
| `factory/driver/futoNotes.ts` | Installed `window.__driver` against the live CM6 view in dev builds |
| `factory/judge/run.ts` | Orchestrator: vault registry surgery, Obsidian launch, CDP connect, driver install, scenario loop, cleanup |
| `factory/judge/diff.ts` | `diffStates(ours, obsidian) → Divergence[]` plus `summarize(reports)` |
| `factory/judge/layoutInvariants.ts` | Our-side-only geometric / computed-style assertions, one `page.evaluate` per scenario |
| `factory/judge/visualDiff.ts` | Clip-bounded screenshot per editor plus a `pixelmatch` diff |
| `factory/judge/visualReport.ts` | Side-by-side HTML report sorted by drift |
| `factory/themes/neutral.css` | Stripped theme injected into both pages so any pixel difference was structural, not chrome |

Reports landed in `factory/captures/last-run.json` as
`{summary: {total, passed, errored, satisfaction, buckets}, reports: [...]}`, with each report
carrying the full `DriverState` from both sides — which is what made a divergence diagnosable
rather than just countable.

## The Obsidian vault-registry dance (the riskiest part)

Obsidian has no "open this vault" command line that leaves the user's setup alone, so the runner
edited Obsidian's own registry at
`~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`: back it up, set every existing
vault to `open: false`, register a throwaway factory vault under a stable hex id
(`fac701ffac701ff0`) with `open: true`, then restore on exit.

This bit us and was hardened in two ways worth remembering if anything similar is ever built:

- **Sanitize the backup, and refuse to overwrite an existing one.** A run killed mid-flight used to
  poison the *next* run's backup, which once stranded the user's Obsidian on the factory vault with
  every real vault closed. The fix was to strip the factory vault out of the backup before writing
  it, and to never clobber an existing `obsidian.json.factory-bak`.
- **Restore is still only crash-safe after boot.** Cleanup ran on graceful exit / SIGINT / SIGTERM,
  so a hard kill during the ~10s boot window left `obsidian.json` pointed at the factory vault
  until the next run self-healed it. Manual recovery: drop the `fac701ffac701ff0` entry, reopen the
  real vault, delete `obsidian.json.factory-bak` and `fac701ffac701ff0.json`.

There was also a hard sanity check before any scenario ran: `app.vault.adapter.basePath` had to end
with the factory vault's basename, or the runner refused to continue. Driving a real vault by
accident was the failure it existed to prevent.

Two more environment notes: the launcher stopped any running Obsidian first (via flatpak's own
per-application stop, not a pattern kill), so the harness was not safe to run while the user had
Obsidian open with unsaved work. And it polyfilled `window.__name = (fn) => fn` in the Obsidian page
before evaluating anything, because tsx/esbuild-transformed callbacks otherwise `ReferenceError`.

## CDP and focus quirks

These are the non-obvious mechanics, and the ones most likely to be re-encountered by anything
driving CodeMirror over CDP:

- **A real Playwright click is required for focus.** Both CM6 and Obsidian's live-preview reveal
  logic check `cm.contentDOM.contains(document.activeElement)`. A programmatic `cm.focus()` does not
  satisfy that — especially with the OS screen locked. A CDP-level click on `.cm-content` does.
- **Cursor placement and arrow keys must go through `page.keyboard`, not the in-page driver.**
  `cm.dispatch({selection})` updates CM's selection state but does not trigger Obsidian's reveal,
  which keys off real trusted `KeyboardEvent`s. The runner sent `Control+Home`, then
  `ArrowDown × line`, `Home`, `ArrowRight × ch`. The in-page driver still owned
  `setDoc`/`type`/`focus`/`blur`.
- **Tag the target editor.** Obsidian has several sibling editors in the page, so both sides marked
  their `.cm-content` with `data-factory-target="true"` for the runner to click.
- **Screen lock does not matter.** Playwright over CDP synthesizes events at the renderer level,
  independent of OS focus or window visibility.

## The four oracles, and what each was blind to

A scenario passed only when all four held; the reported divergence was whichever flagged first.

| Oracle | Surfaced | Blind to |
|---|---|---|
| Doc state | doc bytes, cursor, selection | anything about rendering |
| Decoration buckets | per-`kind` position-set diff against Obsidian | anything not modeled by an `ElementKind` |
| Layout invariants | geometry and computed style on our side only (`getBoundingClientRect`, `getComputedStyle`) | whatever nobody hand-wrote an invariant for |
| Visual diff | pixels, after injecting a shared neutral theme | nothing — but 5–15% baseline noise from font metrics made it usable only on a curated subset |

The layered structure is the transferable idea: the cheap oracle catches replay drift, the bucket
diff catches structural decoration differences regardless of DOM emission order, and only pixels
catch what the user actually sees.

A note on the visual layer: pixel diff says "8% drift"; a vision-capable model reading the same
screenshot pair says "headings render at the inner-text size, not the line size." The second is
where bugs were actually found. It is also non-deterministic across runs, which is why it was never
a gate.

## Lessons learned the hard way

From the 2026-06-25 list/task reveal pass. These are the ones that cost real time.

- **The decoration diff is blind to CSS-pseudo glyphs — screenshot to settle list-marker reveal.**
  Obsidian draws the `•`/`◦` bullet via CSS on `.cm-formatting-list-ul` (a `::before` / list-style),
  not a DOM widget. The decoration walk therefore reports the *identical*
  `cm-formatting-list-ul text="- "` whether Obsidian is showing a dimmed raw `-` (caret on the
  marker) or a rendered `•` (caret elsewhere). `visibleText` is no help either — it is `innerText`,
  which includes the hidden source `-`. Only a screenshot distinguishes them. Tasks are different:
  Obsidian's checkbox *is* a widget, so the decoration set genuinely changes and the bucket diff
  catches it. Trust pixels, not buckets, for unordered-list reveal.
- **A one-line probe document cannot distinguish "reveal on line" from "reveal in marker."** With a
  single line the caret is always on the list line. Park the caret on a second, non-list line to
  capture the fully-rendered state, and probe several columns (0, mid-marker, contentStart,
  mid-word) to find the boundary. Ground truth from that pass: both bullets and tasks reveal iff the
  caret is in the half-open marker range `[markerStart, contentStart)` — a caret *at* the first
  content character re-renders the widget.
- **Cursor-reveal work needs the key-sequence scenarios.** Every justfile recipe passed
  `--no-moves`, which filtered out exactly the arrow-key scenarios that exercise reveal. Running
  the underlying script directly was the only way to include them — a default that quietly excluded
  the interesting cases.
- **The daemon and the Playwright suite could not coexist.** The daemon owned Vite on this
  worktree's web port plus a chromium attached to it. While it was up, own-server mode died with
  "port already used" and dev-server reuse made every test hit its 30s timeout (two chromiums
  fighting over one HMR server). Tear the daemon down first. (Related and still true: piping a
  Playwright run through `| tail` loses its exit code — `tail` exits 0 even when every test failed.
  This is the same M11 trap the `just build` and `just check` recipes set `pipefail` for.)
- **Ad-hoc headless screenshots of the app render blank.** A bare `chromium.launch()` plus a `goto`
  of the dev port screenshots white even with the DOM fully present — theme tokens and fonts do not
  apply the way they do on a themed page. Verify via `innerText` or the aria snapshot, not the
  pixels. Do not chase a "blank" screenshot; check the DOM.
- **Never reach for `innerText` to ask "what does the user see."** Both editors hide markdown
  markers with `color: transparent` + `font-size: 0` (ours) or a `cm-transparent` wrapper
  (Obsidian). The DOM keeps the source text, so `innerText` and `textContent` include it. Anything
  reasoning about visibility must read computed styles — `visibility`, `display`, a non-transparent
  `color`, and `parseFloat(fontSize) > 0`.

## Divergences that were still open

Recorded here because they are real editor behavior, not harness artifacts, and someone will
rediscover them:

- **Emphasis decoration span.** Our italic-text decoration covers the markers (e.g. 8..21 for
  `*italic text*`); Obsidian's covers only the inner range (9..20).
- **Inline links on cursor reveal.** We strip all link decorations when the cursor is on a markdown
  link, showing raw text. Obsidian keeps `link-marker`/`link-text`/`link-url` mark decorations, so
  brackets stay dimmed and the URL stays colored. The fix would be for `decorateLink` in
  `src/features/editor/live-preview/inlineDecorations.ts` to emit mark decorations on reveal,
  mirroring what emphasis and strikethrough already do.
- **External-link affordance.** Obsidian appends a zero-width `external-link` widget after every
  external markdown link; we do not. Worth adopting on its own merits — it gives the user a "this
  leaves the app" cue.
- **Generic marker class.** `cm-md-inline-marker` carries no information about whether the marker is
  bold, italic, heading, or code, so the kind mapping used `italic-marker` as a placeholder and
  every marker bucket was noisy. Refining it needs a post-pass over overlapping text decorations.

## If a parity campaign restarts

The notes the harness left for its own successor: unify the three copies of `classToKinds` into one
module consumed by both drivers, stop defaulting to `--no-moves`, and build the holdout corpus that
was planned but never landed (a parallel gitignored scenario set the working agent cannot read, so
that a satisfaction score means something).
