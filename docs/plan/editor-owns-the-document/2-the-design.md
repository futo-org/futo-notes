## 2. The design — one sentence per rule

1. The shell names the document it hands the editor; the editor stamps that name and a
   generation on everything it says about it.
2. The editor tells the shell, synchronously at the keystroke, when it holds an edit the shell
   has not received (`edited`). It is cheap and carries no content.
3. The editor delivers content (`change`) on the usual debounce, and immediately on its own
   lifecycle edges, on a note switch, and when the shell asks (`flush`).
4. The shell keeps a mailbox per note id: the newest `change` it has and the newest `edited`
   watermark. **The shell is current for a note when `latest.generation >= editedThrough`.**
   That one comparison replaces every read.
5. When the shell is current, an exit, a background flush, a reconcile or a relink proceeds
   on `latest` with no WebView interaction at all.
6. When it is behind, it calls `flush(token)` once and waits for a `change` that satisfies it,
   bounded by a deadline. Deadline with no answer is `unreachable`.
7. `unreachable` while behind: a user-initiated exit refuses once and can be retried (by the
   time the user taps again the change has usually arrived); a system-forced exit (iOS pop,
   background) proceeds on `latest` and leaves the retained-draft retry in place. A renderer
   that died (`onRenderProcessGone`, `webViewWebContentProcessDidTerminate`) marks the page
   unreachable for good, and every path proceeds on `latest` — the edit is gone with the
   process and refusing helps nobody.
8. Replacing the document from outside (sync adopt, relink) is conditional on the generation
   the shell last saw, decided by the editor in one place, never by comparing text.
