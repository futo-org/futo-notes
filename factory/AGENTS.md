# AGENTS.md - Factory

## Status

Campaign tool. This harness requires a Linux host with flatpak Obsidian.
The entry point is the `/editor-parity` skill. Do not port or maintain this
harness unless a parity campaign is active.

The durable regression net is `markdown-spec/cases/` plus
`tests/markdown-spec.spec.ts`.

If a parity campaign restarts: unify the three copies of `classToKinds` into
one module consumed by both drivers, drop `--no-moves` from the justfile
defaults, and build the planned holdout corpus.

A judge that compares FUTO Notes's CodeMirror 6 editor to Obsidian's, scenario by scenario, so we can converge on Obsidian-style live-preview behavior without writing assertions by hand.

## Why this exists

Milkdown's Prosemirror round-trip didn't work for our content model, and we've been rebuilding an Obsidian-style live-preview editor on plain CM6 (`src/components/MarkdownEditor.svelte`, `src/lib/liveMarkdownTransform.ts`). Obsidian is the oracle — same input, same expected behavior. The factory drives both editors with identical scenarios, captures editor state, and diffs.

## Topology

```
markdown-spec/cases/**.yaml            ← scenario corpus (existing, reused)
       │
       ▼
factory/judge/run.ts                   ← orchestrator: launches everything, runs the loop
       │     ┌─────────────────────────────┐
       │     │ Playwright (chromium)       │
       │     │   ↓ goto localhost:5173     │
       │     │   ↓ window.__driver         │  ← futo-notes driver
       │     │     (factory/driver/        │
       │     │      futoNotes.ts wired     │
       │     │      from MarkdownEditor)   │
       │     └─────────────────────────────┘
       │     ┌─────────────────────────────┐
       └───→ │ Playwright connectOverCDP   │
             │   ↓ flatpak Obsidian        │
             │     (--remote-debugging-    │
             │      port=9876)             │
             │   ↓ window.__driver         │  ← Obsidian driver, installed
             │     (inlined in run.ts,     │     in-page on connect
             │      mirrors the protocol)  │
             └─────────────────────────────┘
       │
       ▼
factory/judge/diff.ts                  ← structural diff (cursor, selection, decorations, visibleText)
       │
       ▼
factory/captures/last-run.json         ← {summary, reports[]} for inspection
```

Both editors expose the same `__driver` API on their `window`, so the runner is editor-agnostic — `runOnEditor(page, ...)` works for either.

## Files

| Path | Purpose |
|---|---|
| `factory/driver/protocol.ts` | TS types for `Driver`, `DriverState`, `DriverEvent`, `DecoratedRange`, `ElementKind` |
| `factory/driver/semanticKind.ts` | Maps raw CSS classes → canonical `ElementKind`. Order matters: marker classes (cm-formatting-*, cm-md-inline-marker) win over text classes (cm-em, cm-strong) |
| `factory/driver/futoNotes.ts` | Installs `window.__driver` against the live CM6 view in dev builds. Wired from `src/components/MarkdownEditor.svelte` inside the existing `if (import.meta.env.DEV)` block |
| `factory/judge/run.ts` | The whole show. Mutates Obsidian's vault registry, launches flatpak Obsidian with CDP, connects via Playwright, installs the Obsidian-side `__driver` in-page, runs the scenario loop, restores the registry on exit |
| `factory/judge/diff.ts` | `diffStates(sf, ob) → Divergence[]` plus `summarize(reports)` |
| `factory/judge/layoutInvariants.ts` | SF-only geometric / computed-style assertions — runs in one `page.evaluate` per scenario, surfaces `layout-violation` divergences |
| `factory/judge/visualDiff.ts` | Phase-1 visual oracle: clip-bounded screenshot per editor + pixel diff via `pixelmatch` |
| `factory/judge/visualReport.ts` | Generates `factory/captures/visual-report.html` — side-by-side SF/OB/diff PNGs sorted by drift |
| `factory/themes/neutral.css` | Stripped theme injected into both pages so any pixel difference is structural, not chrome |
| `factory/captures/last-run.json` | Most recent report. `{summary: {total, passed, errored, satisfaction, buckets}, reports: [{name, complexity, satisfaction, divergences[], futoNotes, obsidian}]}` |
| `factory/captures/screenshots/` | `<name>.{sf,ob,diff}.png` for each scenario in the curated visual set (regenerated each `factory-visual` run, gitignored) |
| `factory/captures/visual-report.html` | Side-by-side viewer + LLM-judge entry point (gitignored) |
| `factory/captures/obsidian-vault/` | Throwaway vault Obsidian opens. Recreated each run |

## How a run works

1. Load YAML scenarios via `markdown-spec/loader.ts`. Filters: `--max N`, `--filter <name-substring>`, `--no-moves`.
2. Start (or reuse) Vite dev on `localhost:5173`.
3. `setupVault()` writes config files into `factory/captures/obsidian-vault/.obsidian/`.
4. `prepareObsidianRegistry()` backs up `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`, sets every existing vault to `open: false`, registers our factory vault under a stable hex id (`fac701ffac701ff0`) with `open: true`. Cleanup restores the original.
5. `flatpak kill md.obsidian.Obsidian` (in case one is up), then `flatpak run md.obsidian.Obsidian --remote-debugging-port=9876 <vault>`.
6. Wait for CDP, `chromium.connectOverCDP`, find the renderer page whose title matches `Obsidian`, evaluate that `window.app.workspace` exists.
7. Sanity check: `app.vault.adapter.basePath` ends with the factory vault basename — refuses to continue if Obsidian opened the wrong vault.
8. `installObsidianDriver(page)` opens `__factory_scratch.md`, then evaluates an in-page script that wires up `window.__driver` mirroring FUTO Notes's API. Polyfills `window.__name = (fn) => fn` first so tsx/esbuild-transformed callbacks don't `ReferenceError`.
9. Same Playwright-launched chromium loads `localhost:5173/#/note/new` for FUTO Notes. Wait for `.cm-editor` and `window.__driver`.
10. For each scenario:
    - `runOnEditor(page, markdown, events)` calls `__driver.setDoc(md)`.
    - **Click `.cm-content` via Playwright** to give the editor real focus. CM6 + Obsidian's live-preview reveal logic checks `cm.contentDOM.contains(document.activeElement)`; programmatic `cm.focus()` doesn't satisfy that, especially when the OS screen is locked. The CDP-level click does.
    - `__driver.dispatch(events)` then `__driver.state()`.
    - Same call against the Obsidian page.
    - `diffStates(sf, ob) → Divergence[]`.
11. Write `factory/captures/last-run.json` and `flatpak kill` + restore registry on exit.

In daemon mode, steps 2–9 run once at `factory-up`. Each `factory-run` then re-enters step 10 (the scenario loop) against the already-booted pages and writes a fresh `last-run.json`; teardown only happens at `factory-down`.

## State capture

Both drivers walk `cm.contentDOM` with a `TreeWalker`, collecting `{from, to, kind, replaced, classes, text}` for every element with classes. Position resolution via `view.posAtDOM(node, 0)`. Replaced widgets (HR, table, image, task-checkbox) are detected by class allowlist; their `text` field is empty and `replaced: true`.

`kind` is the canonical `ElementKind` derived from `classes` via `classToKind`. FUTO Notes and Obsidian use different raw classes (`cm-md-emphasis` vs `cm-em`, `cm-md-inline-marker` vs `cm-formatting-em`) — the mapping is what makes them comparable.

## Diff rules

`diffStates` checks:
1. `doc` byte-equal (sanity)
2. `cursor.{line,ch}` match
3. `selection.head/anchor` match
4. `visibleText` (`.cm-content` innerText) match
5. Decorations bucketed by `kind`. Within each bucket, the multiset of `{from.pos..to.pos, replaced}` keys must match. Mismatches surface as `decoration-only-in-futo-notes` / `decoration-only-in-obsidian`.

`unknown`-kind decorations are dropped from the diff to avoid noise.

## Known sharp edges

- **Cursor placement and arrow keys go through `page.keyboard`, not the in-page driver.** Programmatic `cm.dispatch({selection})` updates CM's selection state but doesn't trigger Obsidian's live-preview reveal — that logic keys off real, trusted KeyboardEvents (or focus state). The runner sends `Control+Home` + `ArrowDown × line` + `Home` + `ArrowRight × ch` for cursor placement, and `page.keyboard.press(key)` for `moves`. The in-page driver still handles `setDoc`/`type`/`focus`/`blur`. Both editors tag their target `.cm-content` with `data-factory-target="true"` so the runner clicks the right one (Obsidian has multiple sibling editors).
- **`cm-md-inline-marker` is FUTO Notes's generic marker class.** It carries no info about whether the marker is bold/italic/heading/code. `semanticKind.ts` maps it to `italic-marker` as a placeholder. Refining this needs a post-process pass that looks at overlapping text decorations to derive the actual kind. Until then, marker buckets are noisy.
- **FUTO Notes's italic-text decoration covers the markers (e.g. 8..21 for `*italic text*`).** Obsidian's covers only the inner range (9..20). This is a real structural divergence — neither the kind mapping nor the diff is wrong, the editors really decorate differently.
- **Obsidian needs a real Playwright click to focus.** `cm.focus()` alone doesn't grant `document.activeElement` to the contentDOM, so live-preview reveal stays off. `runOnEditor` clicks `.cm-content` after `setDoc` to fix this. Cursor placement comes after, via `cm.dispatch`.
- **Screen lock doesn't break us.** Playwright over CDP synthesizes events at the renderer level — independent of OS-level focus or visibility.
- **Don't run the judge while the user has Obsidian open.** The launcher will `flatpak kill` it first. The user's main vault is on disk so no data loss, but unsaved work could be at risk in pathological cases.

## Lessons learned the hard way

Things that cost real time on the 2026-06-25 list/task reveal pass. Read these before a similar run.

- **The decoration diff is BLIND to CSS-pseudo glyphs — screenshot to settle list-marker reveal.** Obsidian draws the `•`/`◦` bullet via CSS on `.cm-formatting-list-ul` (a `::before`/list-style), *not* a DOM widget. So the decoration walk reports the **identical** `cm-formatting-list-ul text="- "` whether Obsidian is showing a dimmed raw `-` (caret on the marker) or a rendered `•` (caret elsewhere). `visibleText` is no help either — it's `innerText`, which includes the hidden source `-`. The only way to know which state Obsidian is in is a **screenshot** (`page.screenshot` with a clip around the line). Tasks differ: Obsidian's checkbox *is* a widget, so the decoration set genuinely changes (markers present ⇄ absent) and the bucket diff catches it. Bullets don't — trust pixels, not buckets, for unordered-list reveal.
- **A 1-line probe doc can't distinguish "reveal on line" from "reveal in marker".** In a single-line doc the caret is *always* on the list line, so you can't tell whether a marker reveals because the caret is on the line or specifically inside the `[markerStart, contentStart)` range. Park the caret on a **second, non-list line** to capture the fully-rendered ("off-line") state, and probe several columns (0, mid-marker, contentStart, mid-word) to find the exact reveal boundary. Ground truth from that pass: both bullets and tasks reveal iff the caret is in the half-open marker range `[markerStart, contentStart)` — a caret *at* the first content char re-renders the widget.
- **Run WITH moves for cursor-reveal work.** The justfile recipes (`factory-judge`, `factory-run`, `factory-watch`) all pass `--no-moves`, which filters out exactly the arrow-key scenarios that exercise reveal. Drive the client directly without it: `pnpm exec tsx factory/judge/run.ts run --filter <name>` (optionally `--reload` to force-refresh the futo-notes page after an edit).
- **Tear the daemon down before running the Playwright web suite.** The daemon owns vite on `:5173` *and* a chromium attached to it. While it's up, `pnpm exec playwright test` can't run: own-server mode dies with "5173 is already used", and `PLAYWRIGHT_REUSE_DEV_SERVER=1` reuse makes every test hit its 30s timeout (two chromiums fighting over one HMR server). `run down` first, then run Playwright, then reboot. (Also: pipe a Playwright run through `| tail` and you lose its real exit code — `tail` exits 0 even when every test failed.)
- **Ad-hoc headless screenshots of the app render unstyled/blank.** A bare `chromium.launch()` + `goto('localhost:5173')` screenshot comes back white even though the DOM is fully present — theme tokens/fonts don't apply like they do on the daemon's themed page. Verify via `innerText` or the aria snapshot, not the pixels; or reuse the factory's own `captureEditorScreenshot` (it injects the neutral theme). Don't waste time chasing a "blank" screenshot — check the DOM.
- **Registry restore is now crash-safe — but a boot-time kill still needs one more run to heal.** `prepareObsidianRegistry` sanitizes the factory vault out of the backup and refuses to overwrite an existing `obsidian.json.factory-bak`, so a run killed mid-flight no longer poisons the next run's backup (this previously stranded the user's Obsidian on the factory vault, with all real vaults closed). Cleanup still only runs on graceful exit / SIGINT / SIGTERM *after* boot — if you `kill -9` during the ~10s boot, `obsidian.json` stays pointed at the factory vault until the **next** factory command self-heals it (or restore by hand: drop the `fac701ffac701ff0` entry, reopen the real vault, delete `obsidian.json.factory-bak` + `fac701ffac701ff0.json`).

## Running it

Two modes: one-shot (boot → run → teardown) and a long-running daemon
that keeps Obsidian + chromium up across runs. The daemon mode pays
the ~10s boot tax once, then incremental runs are 0.5–8s instead of
60–90s.

```bash
# One-shot — slowest, fully self-contained.
just factory-judge                  # all no-moves scenarios, headless
just factory-judge-headed           # same, with Obsidian + chromium visible
just factory-judge -- --filter tag  # name substring
just factory-judge -- --max 10      # cap count
just factory-summary                # pretty-print last-run.json

# Daemon — Obsidian + chromium stay up. Boot once, drive many runs.
just factory-up                     # boot daemon (foreground; Ctrl-C tears down)
just factory-run                    # run all scenarios (streams divergences live)
just factory-run --filter cursor    # subset
just factory-visual                 # curated visual subset only — captures screenshots
                                    # + pixel diff + writes visual-report.html
just factory-watch                  # re-run on save of editor source files
just factory-down                   # tell daemon to shut down

# Underneath all of the above:
pnpm exec tsx factory/judge/run.ts                       # one-shot
pnpm exec tsx factory/judge/run.ts daemon                # boot daemon
pnpm exec tsx factory/judge/run.ts run [opts]            # client run
pnpm exec tsx factory/judge/run.ts watch [opts]          # client watch
pnpm exec tsx factory/judge/run.ts down                  # client shutdown

# Common flags (all modes / both client and one-shot):
--filter <name-substring>   # subset by scenario name
--max <N>                   # cap count
--no-moves                  # skip key-sequence scenarios (default in justfile)
--no-obsidian               # futo-notes only — debug the runner itself
--headed                    # show Obsidian + chromium windows
--visual                    # capture screenshots + run pixel diff (slow; opt-in)
--visual-only               # restrict to VISUAL_SCENARIO_NAMES (implies --visual)
```

Exit code (one-shot and `factory-run`): `0` if `satisfaction === 1`, `1`
otherwise, `2` on infra error.

### How the daemon works

`factory-up` runs the same boot sequence as one-shot (dev server,
Obsidian launch, chromium connect, both `__driver`s installed) but then
binds a Unix socket at `factory/captures/daemon.sock` and waits.

Clients connect, send a single newline-delimited JSON command, and read
NDJSON progress events back:

| `cmd`        | Server emits                                   |
|--------------|------------------------------------------------|
| `run`        | `started` → `progress` × N → `summary`         |
| `shutdown`   | `log` ack, then closes the socket and exits    |

`factory-watch` chokidars `liveMarkdownTransform.ts`,
`MarkdownEditor.svelte`, `markdown.css`, and the factory's own driver/
diff sources. On change it sends a `run` with `reload: true`, which
makes the daemon refresh the futo-notes page first so HMR drift can't
lie. Saves while a run is mid-flight queue exactly one re-run.

### Streaming output

Both `factory-judge` and `factory-run` stream one line per scenario as
it completes:

```
[  3/60] tag-basic                                OK
[  4/60] tag-with-emoji                           1 div  — tag 5..12 (mark) — futo-notes has, obsidian missing
```

The first divergence's `detail` shows inline so you can Ctrl-C as soon
as you've learned what you needed.

## Reading a report

```bash
node -e "
const r = require('./factory/captures/last-run.json');
console.log(r.summary);
for (const rep of r.reports.filter(rr => rr.divergences.length).slice(0,5)) {
  console.log('\n===', rep.name);
  for (const d of rep.divergences) console.log('  -', d.kind, d.detail);
}
"
```

For a single scenario, the full `futoNotes` and `obsidian` `DriverState` is included in the report — useful for understanding *why* something diverged.

## Oracle layers

The factory has four oracles that compose. A scenario passes when *all* of them
hold; a divergence is whichever oracle flags first.

| Oracle | Surfaces | Strengths | Failure mode |
|---|---|---|---|
| **Doc state** (`diff.ts`) | doc bytes, cursor, selection | Cheap, deterministic, catches setDoc / event-replay drift | Won't notice rendering bugs |
| **Decoration buckets** (`diff.ts`) | per-kind position-set diff against Obsidian | Catches missing/extra decorations regardless of DOM emission order | Blind to anything not modeled by an `ElementKind` |
| **Layout invariants** (`layoutInvariants.ts`) | SF-only assertions via `getBoundingClientRect` and `getComputedStyle` | Catches geometric bugs the bucket diff never would (cursor invisibility, heading line-height ordering, `>` leaking through) | Each one is hand-written; gaps hide bugs |
| **Visual oracle** (`visualDiff.ts`, phase 1; LLM judge, phase 2) | pixel diff between SF and OB screenshots after a shared neutral theme is injected | Catches *anything* that affects what the user sees | Brittle (5–15% baseline noise from font metrics); needs a curated subset |

The visual oracle is two phases:

- **Phase 1 (automated):** `just factory-visual` injects `factory/themes/neutral.css` into both pages, screenshots a clip box around just the rendered lines for every scenario in `VISUAL_SCENARIO_NAMES` (in `visualDiff.ts`), and runs `pixelmatch` with a 0.1 threshold and 1% tolerance. Drift over tolerance becomes a `visual-divergence`. Output: `factory/captures/screenshots/` and `factory/captures/visual-report.html`.

- **Phase 2 (Claude Code as LLM judge):** open the report or hand Claude the screenshot pair paths. Claude reads them via the Read tool (vision-capable) and describes *what* changed — not just that drift exists. Pixel diff says "8% drift"; Claude says "headings render at the inner-text size, not the line size" or "bold inside heading isn't visually heavier." This is where the actual bug-hunting happens. Don't gate CI on it — non-deterministic across runs.

Workflow: run `just factory-visual`, look at the report, then say "review the visual report" and Claude will read each pair under `factory/captures/screenshots/` and surface the structural differences.

### Adding a visual scenario

1. Add (or use an existing) YAML scenario in `markdown-spec/cases/**`.
2. Add the scenario name to `VISUAL_SCENARIO_NAMES` in `factory/judge/visualDiff.ts`. Keep the set tight — pixel diff is fragile, and we'd rather look at 20 carefully than 218 carelessly.
3. Re-run `just factory-visual`. The diff PNG is in `factory/captures/screenshots/<name>.diff.png`.
4. If the drift is real, fix and iterate. If the drift is theme-noise, tighten `factory/themes/neutral.css` until both editors render identical pixels for that case.

### Adding a layout invariant

Each invariant is one `{ name, description, fn }` entry in the `INVARIANTS_SOURCE` string in `factory/judge/layoutInvariants.ts`. The `fn` runs in-page and returns:

- `null` → not applicable (e.g., no list line present in this scenario)
- `undefined` → applicable and passing
- `string` → failure detail surfaced in the report

All invariants run in one `page.evaluate` per scenario, so adding more is cheap. Examples in the file:

- `caret-visible-on-list-line` — a cursor on a list line must produce at least one client rect (catches "caret invisible because it landed inside a `Decoration.replace`")
- `cursor-clear-of-bullet` — when the visible caret is past the bullet, gap must be ≥ 2px
- `heading-line-height-ordering` — h1 ≥ h2 ≥ ... ≥ h6
- `no-quote-marker-bleeds-through` — a blockquote line whose `>` is supposed to be hidden must not have any visible (font-size > 0, non-transparent) `>` text

**Rule of thumb for adding one:** if I just fixed a bug, write the invariant that would have failed *before* the fix. The invariant is a regression test that doesn't depend on a hand-coded scenario YAML.

### Don't reach for innerText

Both editors hide markdown markers via `color: transparent` + `font-size: 0` (SF) or a `cm-transparent` wrapper (Obsidian). The DOM keeps the source text in place — `innerText` and `textContent` *include* it. Anything reasoning about "what does the user see" must use computed styles:

```js
const cs = getComputedStyle(parent);
const visible =
  cs.visibility !== 'hidden' &&
  cs.display !== 'none' &&
  cs.color !== 'rgba(0, 0, 0, 0)' &&
  cs.color !== 'transparent' &&
  parseFloat(cs.fontSize) > 0;
```

`diff.ts`'s `normalizeVisible` is *not* a "what the user sees" oracle — it strips punctuation. It catches gross word-level drift; not visual leaks. Visual leaks belong in a layout invariant or the visual oracle.

## Where to take it next

1. **Inline-link decorations on cursor reveal.** When the cursor is on a markdown link, SF strips all link decorations (showing raw text), Obsidian keeps `link-marker`/`link-text`/`link-url` mark decorations (so brackets are dimmed, URL is colored). Change `processLink` in `liveMarkdownTransform.ts` to emit mark decorations when the link is revealed, mirroring the pattern already used by emphasis/strikethrough.
2. **External-link affordance.** Obsidian appends a 0-width `external-link` widget after every external markdown link. SF doesn't. Worth adopting regardless — gives users the "this leaves the app" cue.
3. **Pick the highest-leverage divergence and converge.** After each run, look at `factory/captures/last-run.json`'s `summary.buckets` for the top-line counts, and group `decoration-only-in-*` divergences by their leading kind token to find the biggest sub-buckets — `factory-summary` does the worst-scenarios cut, but a one-liner over `reports[].divergences[].detail` gives you per-kind counts. Pick the biggest, find a representative scenario in the report (full `futoNotes` and `obsidian` `DriverState` are included), and trace it to a code path in `liveMarkdownTransform.ts`.
4. **Add a holdout corpus.** Today every scenario is open and the agent can read the YAML. Once the worker agent is autonomous, hold back a parallel set in `factory/holdout/` (gitignored) so merges are gated on satisfaction the agent can't peek at.
5. **Visual diff layer.** Once structural is green, normalize themes and screenshot-diff. Last priority — structural catches ~95%.
