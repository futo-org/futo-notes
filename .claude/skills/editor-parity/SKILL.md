---
name: editor-parity
description: "Drive the factory/ judge harness that compares our CM6 live-preview editor against Obsidian scenario-by-scenario, triage divergences, and turn confirmed ones into fixes locked by markdown-spec cases. Use when the user says \"run the factory\", \"compare to Obsidian\", \"editor parity\", \"review the visual report\", \"why does Obsidian render this differently\", or after editor changes (liveMarkdownTransform, markdown.css, cursor movement) that should be checked against the oracle."
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Editor Parity (factory judge)

`factory/` treats Obsidian as the oracle for the live-preview editor and diffs FUTO Notes against
it over the same `markdown-spec/cases/**` corpus, through four composed oracles:

1. **Doc state** — doc bytes, cursor `{line,ch}`, selection, visible text.
2. **Decoration buckets** — both editors' `contentDOM` walked and normalized to canonical
   `ElementKind`s (`semanticKind.ts`), position-multisets compared →
   `decoration-only-in-futo-notes` / `decoration-only-in-obsidian`.
3. **Layout invariants** — SF-only geometric assertions (caret visible, cursor clear of bullet,
   heading line-height ordering, …) → `layout-violation`.
4. **Visual oracle** — neutral-theme pixel diff (`visual-divergence`) + an optional LLM pass over
   the screenshot pairs.

Read `factory/AGENTS.md` before the first run of a session.

## Preflight (skipping these wastes a run)

- [ ] The user's own Obsidian must NOT be running (the daemon rewrites the Obsidian vault
      registry to a throwaway factory vault, and restores it afterward).
- [ ] Don't run alongside the Playwright web suite — both fight over `:5173`. Tear the daemon
      down (`just factory-down`) before `just test-e2e*`.
- [ ] If a previous daemon was `kill -9`'d at boot time, the registry self-heals on the next
      run — expect one throwaway run.

## Workflows

**Iterating on editor code (the main loop):**

```bash
just factory-up            # boots Obsidian + chromium ONCE, listens on factory/captures/daemon.sock
                           # (foreground; run in background, Ctrl-C/factory-down tears down)
just factory-run           # one run against the live daemon (0.5–8s, vs 60–90s cold)
just factory-watch         # re-runs on every editor-source save, reloads the page first (no HMR lies)
just factory-down
```

**One-shot judgment** (no iteration planned): `just factory-judge` (add `--headed` to watch).
**Score summary + worst scenarios:** `just factory-summary`.
**Visual oracle:** `just factory-visual` (daemon must be up) → pixel-diffs the curated visual set,
writes `factory/captures/visual-report.html` and per-scenario
`factory/captures/screenshots/<name>.{sf,ob,diff}.png`. For the LLM judge pass, Read the `.sf.png`
/ `.ob.png` pairs and describe what differs — this pass is advisory, never a gate.

Narrow a run while iterating with a scenario filter / complexity cap if supported by the current
`run.ts` flags (check `pnpm exec tsx factory/judge/run.ts --help`); otherwise use
`factory-summary`'s worst-scenario list to focus your reading.

## Triage — read `factory/captures/last-run.json`

`summary.satisfaction` is the score (exit 0 iff 1.0); `reports[]` carries per-scenario
`divergences[]` plus the full `DriverState` for both editors. Bucket first, then work worst-first
(`just factory-summary` prints the worst 15).

Per divergence type:

| Type | Playbook |
|---|---|
| doc/cursor/selection mismatch | Real behavior bug candidate — usually cursor-reveal or movement logic (`liveMarkdownTransform.ts`, movement handlers). Reproduce by hand in `just tauri-dev` before fixing. |
| `decoration-only-in-obsidian` | We fail to decorate something. Check whether the `ElementKind` mapping in `factory/driver/semanticKind.ts` covers our class name BEFORE concluding the editor is wrong — a classification gap looks identical to a rendering gap. |
| `decoration-only-in-futo-notes` | We decorate something Obsidian doesn't. Decide: our improvement (document as intentional divergence) or our bug. |
| `layout-violation` | CSS/geometry — fix in `src/styles/markdown.css` / widget sizing. Remember CM6 overrides need `!important` inside layered CSS. |
| `visual-divergence` | Open the three PNGs. Structural difference → treat as decoration/layout above; anti-aliasing-scale noise → tolerance, not a bug. |

**Known blind spots — do not chase ghosts:**
- Unordered-list bullet glyphs are CSS pseudo-elements: **invisible to the decoration diff** —
  trust the pixel oracle for bullet-reveal questions.
- Cursor placement and arrow moves go through real `page.keyboard` (Obsidian's reveal needs
  trusted events), and Obsidian needs a real click on `.cm-content` to focus. A scenario that
  errors on focus/typing is usually harness, not editor.
- Obsidian is the oracle for *markdown semantics*, not for our deliberate product choices. A
  divergence contradicting a `docs/spec/editor.md` line or an "intentional platform difference"
  note is NOT a bug — record it as intentional if not already recorded.

## Convergence loop (per confirmed divergence)

1. Minimal repro: shrink the scenario markdown to the smallest doc that still diverges.
2. Fix (`liveMarkdownTransform.ts` / movement logic / `markdown.css`), with `just factory-watch`
   giving per-save re-judgment.
3. Lock it: add a `markdown-spec/cases/<NN-topic>/*.yaml` case for the behavior (static
   decoration or movement case) so the parity survives without the factory running —
   `pnpm run test:markdown-spec` must pass.
4. Spec: update `docs/spec/editor.md` if the behavior is user-facing (`/spec-sync`).
5. Full `just factory-run` — confirm satisfaction did not regress elsewhere (fixes here love to
   break sibling scenarios; the run is cheap, always re-run whole).

## Done criteria

- [ ] `satisfaction === 1`, OR every remaining divergence is explicitly classified as
      intentional (and recorded in `docs/spec/editor.md` if user-facing)
- [ ] Every fixed divergence has a locking `markdown-spec` case; `pnpm run test:markdown-spec` green
- [ ] `just build` + the editor unit tests green (7.2 chain in AGENTS.md)
- [ ] Daemon torn down (`just factory-down`), Obsidian registry restored (automatic)

## Report format

Before/after satisfaction · divergences fixed (scenario → root cause → fix file) · divergences
classified intentional (with the spec line) · new markdown-spec cases added · anything the
harness itself got wrong (semanticKind gaps, flaky focus) fixed or filed.
