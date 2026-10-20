## Saving & rename

The engine's whole contribution to this section is the change/capture contract, and it is tested
against Milkdown directly: a real keystroke posts exactly one change carrying the normalized
document; a host `setContent`/boot note posts no change (the load‑echo guard, ADR‑0002's
reference behavior); `getContent` returns the host's own bytes while clean; and no change can
fire while a progressive open streams (the save lock, T8). `[milkdown]` covers all four.
Everything else in the section is shell/engine‑side code the editor swap does not touch.

| Spec line | Verdict | Evidence |
|---|---|---|
| Body autosave debounce; save re‑reads the id at fire time | PASS | `[shell]` scheduleSave; bridge change contract `[milkdown]` |
| Explicit committed/failed save outcomes; failed writes keep the draft dirty; identity mutations vs retained drafts | PASS | `[shell]` NativeMutationOutcome tests (Android JVM suite run this audit; iOS suite per evidence note below) |
| Title debounce → rename; body flushed to the current id first | PASS | `[shell]` commitRename |
| Leaving the editor flushes only if content changed | PASS | Load‑echo guard `[milkdown]` + `[shell]` |
| Delete is the final mutation; session serialization; iOS quarantine/cover rules | PASS | `[shell]` EditorSession suites |
| Backgrounding best‑effort flush | PASS | `[shell]` |
| `flush_draft` one‑verb dispositions (wrote/converged/recreated/parked) | PASS | Rust store tests + FFI contract + both shells' suites — engine‑independent |
| Durable flush always advances the saved baseline | PASS | `[shell]` SettledFlushTests / NonCancellable span |
| Draft register derived, owner‑scoped | PASS | `[shell]` |
| Empty title → "Untitled"; title strips newlines | PASS | Native title fields, outside the WebView |
| Whitespace‑only title difference skips the write | PASS | `[shell]` |
| Duplicate title blocks the save with the inline warning | PASS | `[shell]` |
| No word count in editor chrome | PASS | Unchanged |
| Tauri title contract (10 s debounce, blur/Enter commits, pointer‑gesture deferral) | DESKTOP‑CM6 | noteSession/createNoteTitleController unchanged |
