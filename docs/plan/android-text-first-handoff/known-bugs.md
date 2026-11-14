# Android text-first handoff: Known bugs and gaps

[← handoff index](README.md)

## 7. Known bugs and gaps

### Android-specific

- **#336:** large notes take 1.4–2.7 s to open on low-end phones.
- **Typing budget on the Moto is unmet or unmeasured.** The last (non-comparable) Moto run had
  19.4% of keys within one frame, median p95 36.7 ms and worst p95 818 ms. It has not been
  repeated since the perf climb. The emulator suite skips the timing probes.
- **No cross-platform sync leg for text-first.** `test:cross-platform-sync:android` pins the
  WebView editor.
- **#334** (instrumentation: run all classes once, fail on missing classes) and **#335** (CI:
  run Android instrumentation tests) are still open. `just test-android-ui` covers most of
  #334 locally; what's left of #335 is unverified, since `build:android-native` already runs
  the connected suite.
- **Evidence is stale for the newest commits.** The combined 227-test run predates
  `70e83ec5b`, `fc607f22a`, `6a1712e4e`, `0d8b90202` and `22d289207` (the in-place table
  field). A fresh combined run was pending (MR description).
- **The WebView editor was not fully re-run** after the shared Kotlin changes
  (`StorageMigrationGate`, leave-note save handling, camera recreation, the Find query
  widget).
- **Behavior that contradicts the latest decisions:** the link tap rule (§5.4) and image tap
  (§5.3).
- **Mason decision 4** (whole-selection lighting, dimming) is provisional, waiting on Mason.
- From the Mason round: physical Gboard checks and low-end frame budgets "remain unverified";
  the original "typing produces nothing after format toggles" report (F1) never reproduced.

### Shared engine bugs on main (they affect Android too)

From `mrqa-engine-artifacts/IOS-INTEGRATION-QUEUE.md`:

- Word completion with Bold toggled off: `hel` → `hello` gives `**hel**lo`. Not filed yet.
- Find: the first press with no current match but total > 0 should step.
- A selection that partly covers an image leaves fragments (!595 review, MEDIUM). The spec
  line `portable-core/interpretation-and-input.md:22` (line number per the queue) needs the image exception.
- Setting a link over a table destroys the table (one Undo restores it). A link next to a
  whitespace-only code span loses its formatting.
- `>-` list Enter leaves the quote. Code-off turns CRLF into LF in mixed-ending notes.
  Backspace on the blank line after a fence errors. (Code-off in a list item dropping the
  marker was !622's scope, and !622 landed in !632; whether that closes it is unverified.)
- `>\t Z` shows a visible leading space (pre-existing). The Enter panic in a tab-indented list
  inside a quote is fixed by !630 (`a58005d6f`).
- Style plan: a lone `\r` before `\r\n` in a window (e.g. `- a\r\r\n`) disagrees with the
  whole plan. LOW, latent: no host uses windows yet.
- Seen on iOS, not checked on Android: an empty heading on the last line isn't styled; a
  toolbar list on a quote adds a blank line on the first keystroke.
- Dropped save-lock work (§4): a save during sync can stall typing (+619 ms for a 600 ms save
  measured on iOS). Deferred on purpose.

