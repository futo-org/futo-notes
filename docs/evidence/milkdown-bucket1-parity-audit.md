# Milkdown bucket‑1 spec parity audit — line by line (T11, issue #108)

**Scope.** The `docs/spec/editor.md` bucket‑1 sections this ticket names — saving & rename,
editor exits, Android IME, theming, cursor/selection, external links, interactive elements
(docs/plan/milkdown-transition.md §4). The other bucket‑1 surfaces were audited by their own
tickets and their evidence stands: wikilinks (T4/#101), tags + checkboxes + fence highlighting
(T5/#102), images (T6/#103), toolbar (T7/#104), progressive open (T8/#105), WebView floor
(T10/#107). Live‑preview/decorated‑source sections are bucket‑2 by decision D6 — renegotiated in
the swap's spec MR, not matched — and are out of scope here.

**Where Milkdown runs today.** The Milkdown editor is the native shells' embedded editor
(`editor.html`, iOS + Android); the desktop app still mounts CodeMirror until the three‑platform
swap (#111). Spec lines tagged `_(desktop)_` therefore audit as **DESKTOP‑CM6** — the shipped
behavior is unchanged by this branch, and the line is re‑audited at the swap.

**Verdicts.**

- **PASS** — the behavior holds under Milkdown, with the evidence cited.
- **FIXED** — a residual surfaced in this audit and was fixed in this ticket, with regression
  coverage at the cited seam.
- **RENEGOTIATE** — the line is CodeMirror‑shaped (it describes the source‑text editing model);
  the WYSIWYG engine meets the line's *intent* a different way, recorded here (and as an inline
  spec Gap where user‑visible) as input for the bucket‑2 spec MR (D9).
- **DESKTOP‑CM6** — a desktop‑tagged line; not a Milkdown surface until #111.
- **GAP** — an already‑recorded spec Gap that stands unchanged; cited, not re‑litigated.

**Evidence keys.**

- `[interactive]` tests/editor-embed-milkdown-interactive.spec.ts — added by this ticket; drives
  the built `editor.html` (the exact bytes both native shells ship).
- `[milkdown]` tests/editor-embed-milkdown.spec.ts, `[parity]`
  tests/editor-embed-milkdown-parity.spec.ts, `[toolbar]`
  tests/editor-embed-milkdown-toolbar.spec.ts, `[wikilinks]`
  tests/editor-embed-milkdown-wikilinks.spec.ts, `[compat]`
  tests/editor-embed-milkdown-compat.spec.ts, `[floor]`
  tests/editor-embed-webview-floor.spec.ts — the existing bundle‑seam suites. Whole
  `test:e2e:editor-embed` run this audit: **259 passed, 0 failed** (exit 0), of which 14 are
  this ticket's `[interactive]` file.
- `[unit]` vitest at the module seam (file named per row).
- `[shell]` the native shells' own test suites (EditorSessionTest.kt / EditorSessionTests.swift,
  NativeMutationOutcome*). The load‑bearing fact for every `[shell]` row is that **this branch
  changes no shell code** — the diff is confined to the editor bundle's TS/Svelte plus tests and
  docs — and the editor reaches these paths only through the bridge, whose contract is unchanged
  (`bridge-spec:check` green). The Android JVM suite (`just test-android-native`) was RUN this
  audit; the iOS Swift suite (`just test-ios-native`) was NOT — it needs macOS, same reason as
  the iOS device leg below. A `[shell]` row therefore means "specified behavior lives in
  unchanged shell code, covered by that shell's own suite", not "re‑measured here".
- `[census]` the measurement `packages/editor/AGENTS.md` mandates for any change under
  `src/milkdown-compat/` — `just milkdown-census --variant baseline` (unpatched upstream preset)
  then `just milkdown-census --diff build/milkdown-census/baseline` — over the **full corpus,
  30,995 notes**, both runs this audit:

  > `vs build/milkdown-census/baseline: 339 flags cleared, 0 newly raised` — exit 0.

  That clears the stated bar ("zero newly-raised flags over ~31k real notes"). The compat set
  now takes `br_loss` 61 → **0**, `html_loss` 61 → **0**, `empty_link_loss` 26 → **0**, and
  `text_loss` 482 → 437. A second, narrower run isolated *this ticket's* serializer handler by
  patching only it out (`--limit 4000`): counters identical with and without it, so the handler
  raises no flag and clears none on its own.
  Note what the census does *not* show: it has no counter for the empty‑cell rewrite, so for
  this ticket it is evidence of **no regression**, not evidence of the fix's benefit — that is
  the unit + bundle‑seam + device coverage below.
- `[device]` the Android pool emulator futo‑qa‑3, claimed by this worktree via
  `just qa-claim android` and driven this run; the oracle is the note file on disk. The iOS leg
  was NOT run — see "Device legs" below.
- `[probe]` behavior measured against the built bundle during this audit via a throwaway
  scratch probe, with the observed values quoted in the row. Not a committed test; rows that
  rest on a probe alone say so.

---

- [Theming](milkdown-bucket1-parity-audit/theming.md)
- [Cursor](milkdown-bucket1-parity-audit/cursor.md)
- [External links](milkdown-bucket1-parity-audit/external-links.md)
- [Interactive elements](milkdown-bucket1-parity-audit/interactive-elements.md)
- [Saving & rename](milkdown-bucket1-parity-audit/saving-rename.md)
- [Editor exits _(iOS/Android)_](milkdown-bucket1-parity-audit/editor-exits.md)
- [Android — IME](milkdown-bucket1-parity-audit/android-ime.md)
- [Residual fixes landed by this ticket](milkdown-bucket1-parity-audit/residual-fixes-landed-by-this-ticket.md)
- [Device legs (hardware note)](milkdown-bucket1-parity-audit/device-legs.md)
