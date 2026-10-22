## 0. Verdict in one paragraph

Desktop overlays became partly visible at `9bc08048`, when the `flushSync()` in `takeSnapshot` went in.
Before that commit, **every** overlay-opening verb in `.agent/trace.jsonl` got the receipt "no change": 37
of 37 `ShowNoteContextMenu`, 17 of 17 `OpenMoveNotePicker`, 28 of 28 `PickFolder`, and 12 of 12
`SetSearchQuery`. What agents see today is element rows appearing. They do not see an overlay as an
object: nothing says what it is, which one is on top, whether it is modal, or what sits behind it.
Focus, the value of a labelled input, `checked`/closed state, and side effects such as a clipboard
write, a vault mutation, a toast or an error either do not reach the receipt at all or reach it only
as noise. Native screens report `screen`, plus `sheet` on iOS, and nothing else about overlays, focus
or the keyboard.

The fix is a **single derived `ui` block** with the same shape on every platform:
`{overlays, focus, window, notice, busy}`. It is computed from what the platform already exposes to
assistive technology: ARIA plus the hit-test in the webview, the presented-view-controller chain plus
the first responder on iOS, and the windows plus the Compose semantics on Android. It goes into
`state`, into the snapshot (so into every diff), and into a continuous evidence ring. Two narrow
chokepoints cover what nothing can derive: OS dialogs and vault effects. Two gates keep it that way:
a static check that overlay markup carries an overlay role, and a runtime sweep in which every
opener verb must change `ui`.

---
