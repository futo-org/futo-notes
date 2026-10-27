## 4. One state and diff model across desktop, iOS and Android

- **Today** there are three models:
  - the desktop page diffs its own snapshots (elements, doc hunk, selection, `shell`, but not
    `find` or focus);
  - the phones forward page diffs for editor verbs only;
  - native verbs return `{ok, verb}`.
  46 of 109 iOS Jev turns got a receipt that said nothing.
- **Proposed.** `act` = `state` (s₀) → `do` → `state` (s₁), inside one CLI process. In a batch,
  step *n*'s s₁ is step *n+1*'s s₀. Then `diff_states(s₀, s₁)`, in Rust, gives the dotted paths,
  the changed lines (from `editor.lines`), the vault set differences, verbs ±, and overlay ±.
  - **One implementation, for all three platforms.** Swift and Kotlin only return AppState; they
    carry no diff code.
  - The page's `changedSinceLast` stays as the only page-side addition, shown as the `late:`
    line. It was needed in 8 of 9,049 receipts.
  - The page element diff moves into the trace's raw page record, which is sibling (a)'s concern.
- **Cost.** One extra `state` round trip per `do` invocation. On desktop that is in-process over
  the open WebSocket, under 10 ms. On the phones, `state` forwards to the page's JS once; this
  needs measuring, with a budget of 50 ms. It is paid for by deleting the CLI `step` note-load
  poll (up to 1.5 s for an empty note) once settle (audit C3) makes `editor.loading` truthful.

---
