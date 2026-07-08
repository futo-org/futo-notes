---
name: spec-sync
description: Keep docs/spec/ (the behavioral source of truth for all three apps) in lockstep with reality. Use when the user says "update the spec", "record a gap", "close that gap", "spec pass", "is the spec up to date", after landing any behavior change, when a spec-gaps-check closure probe fires, or when QA findings need to be turned into spec lines. Owns the full gap lifecycle - hidden-affordance verification, gap wording, GAPS.md regeneration, and closure probes.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Spec Sync

`docs/spec/<area>.md` states what the app should do, by surface, across Tauri desktop, native iOS,
and native Android. A requirement exists in one place even when a platform doesn't satisfy it yet
— that's what makes gaps visible. This skill keeps that file set true.

## The model (internalize before editing)

- **One behavior per line**, plain prose. A spec line is a requirement, not a test.
- A behavior is true on **all platforms by default**. Platform-specific lines get an inline tag:
  `*(Android)*`, `*(iOS)*`, `*(desktop)*`, `*(native shells)*`. Whole platform-specific sections
  get the tag in the heading (`## Tag bar *(desktop)*`).
- `→ path` at the end of a line points at the authority — the code where the behavior is
  load-bearing, the guarding test/scenario by name, or a learning doc.
- Intended divergence is stated as such ("intentional platform difference, not a gap"), so it
  never reads as an accident.
- Verified behavior may carry a dated note ("Verified on the emulator 2026-06-09").
- **Layering:** the spec sits above `tests/conformance/*.json` (TS↔Rust rule parity) and
  `markdown-spec/cases/*.yaml` (editor decoration/cursor fixtures). Reference those corpora,
  never duplicate their cases as prose.
- `docs/spec/GAPS.md` is GENERATED — never edit it by hand; regenerate with `just spec-gaps`.

Example lines to imitate:

```markdown
- **The filename IS the title.** `"grocery list.md"` → title `"grocery list"`. No case changes,
  no dash→space, no transformations; only filesystem-breaking characters are stripped. → `sanitizeTitle`
- A blurred editor reveals nothing — all markers stay hidden.
- An edit made on one device appears on another device after a sync cycle.
```

## Mode A — After a behavior change (the default, run on every behavior-touching diff)

1. Map the changed files to spec areas:

   | Changed | Spec file |
   |---|---|
   | MarkdownEditor, liveMarkdownTransform, listContinuation, tableEditor, markdownToolbar, `packages/editor` | `editor.md` |
   | Note list, sidebar, drawer, ForYouPage, note actions | `list.md` |
   | Routing, shell chrome, tabs | `nav.md`, `tabs.md` |
   | search* (TS or `futo-notes-search`) | `search.md` |
   | Settings screens | `settings.md` (+ `settings-visual.md` for visual changes) |
   | sync* (TS), `crates/futo-notes-sync`, `sync.rs`, server contract | `sync.md` |
   | App init, appState, updater, crash reporting, vault location | `app.md` |

2. Read the relevant sections. For each behavior your diff established, changed, or removed:
   update the line, or add one in the matching section. Match the house style above. For sync
   behaviors, name the guarding test/scenario on the line (e.g. "Regression-guarded by the
   `image sync roundtrip` cross-platform scenario").
3. If the change closes or opens a gap → Mode B/C.
4. `just spec-gaps-check`. If it flags staleness, `just spec-gaps` and commit `GAPS.md` together
   with the spec edit.

## Mode B — Recording a gap

A gap is a **known missing or divergent behavior**, recorded inline where the requirement lives:

```markdown
> **Gap:** Android pre-11 (API < 30) devices can't use Device storage (All-files
> access is an API-30 mechanism) — they only get App storage, so their vault is
> not visible in a file manager. *(Android)*
```

(`> **Gap (iOS):**` / `> **Gap (parity):**` qualifiers are also used.)

**Before recording "X has no UI", run the hidden-affordance checklist** (from
`docs/spec/AGENTS.md` — "no caller I noticed while clicking around" is not evidence):

- [ ] Right-click / long-press context menus on the relevant element
- [ ] Swipe actions (iOS list `custom_actions`, Android swipe)
- [ ] Overflow (`…`) menus and toolbars
- [ ] Keyboard shortcuts (check `keyboard.svelte.ts` and `tabs.md`)
- [ ] Drag & drop targets
- [ ] Hover-revealed controls and empty-state affordances
- [ ] Grep for the store/core method — "exists in core but no caller" is a REAL gap; phrase it
      that way

Then:
1. Write the `> **Gap:**` blockquote inline in the area file, worded so a grep-level closure
   probe could match it (name the missing symbol/behavior concretely).
2. If the gap is code-detectable, add a closure probe to `scripts/spec-gaps.mjs` (the probes that
   flag "the codebase suggests this gap got implemented").
3. `just spec-gaps` → commit the spec file + regenerated `GAPS.md` together.

## Mode C — Closing a gap

1. Verify the behavior actually works NOW, on the platform(s) the gap names — run the app
   (`/verify` has the per-platform playbooks), don't close from code inspection alone. Note the
   date in the replacing line ("verified on the emulator YYYY-MM-DD").
2. Replace the blockquote with the positive behavior line (or delete it if the line above already
   states the requirement).
3. Remove the matching closure probe from `scripts/spec-gaps.mjs` if one exists.
4. `just spec-gaps` → commit spec + `GAPS.md`.

When a `spec-gaps-check` **closure probe fires** in CI or `just check`: treat it as Mode C with
extra skepticism — the probe found code evidence, but only runtime verification closes a gap. If
the behavior is still broken despite the code existing, keep the gap and reword it so the probe
no longer misfires.

## Mode D — Audit pass ("is the spec up to date?")

1. `git log --oneline $(git describe --tags --abbrev=0)..HEAD` → bucket commits by spec area via
   the Mode A table.
2. For each area with behavior-touching commits, diff the spec's claims against the code and any
   QA ledgers in `test-screenshots/*-ledger.md`.
3. Produce a punch list: lines to add / lines now wrong / gaps to open / gaps to close, then
   execute Modes A–C on it.
4. Finish with `just spec-gaps-check` green.

## Done criteria

- [ ] Every behavior the diff touched has a current line in the right area file
- [ ] No hand-edits to `GAPS.md`; regenerated and committed when gaps moved
- [ ] New gaps passed the hidden-affordance checklist and are probe-matchable
- [ ] Closed gaps were runtime-verified, with date
- [ ] `just spec-gaps-check` exits 0
