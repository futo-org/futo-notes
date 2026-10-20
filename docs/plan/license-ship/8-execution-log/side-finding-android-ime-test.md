### Side finding — the Android IME test red is not ours — 2026-09-16

`just test-android-native-ui` fails on `com.futo.notes.ui.components.DialogImeDismissTest >
dialogFieldKeepsFocusAndKeyboardWhileImeShows` ("activity window never saw the ime insets") often
enough that Phases 5 and 7 will both meet it. **Verdict: pre-existing, environmental, not a
regression — do not chase it, and do not weaken it to get green.**

Evidence: a clean control was built from `origin/main` (`24348b91`) in a throwaway worktree and the
class run 4× there and 4× on `feat/license`, on two different pooled API 36 devices — **8/8 passes**,
read from the JUnit XML rather than console scrollback. `DialogImeDismissTest.kt` and `ImeDismiss.kt`
are byte-identical between the two branches, and the test is a pure `createComposeRule()` test with
its own `Dialog` that never launches `MainActivity`, so nothing in the license work can reach it.

Two corrections to the first read of it:

- The `Build.VERSION.SDK_INT >= 35` branch is **not** dead code that CI never exercised. It was added
  deliberately (`c4db93a6` / `6a6f5ab2`) and verified green on API 35 **and** API 36 at the time.
- So this is not an API-level gap in the device pool, and there is no evidence Android 16 changed
  inset behavior.

Root cause is a fixed `Thread.sleep(1500)` budget in the test — chosen over the Compose test clock
because "the phantom hide fired as the IME's show animation settled". Under heavy parallel load on
this machine (many worktrees, emulators and builds at once) the IME is confirmed shown via `dumpsys`
while the activity window's inset visibility has not flipped yet when the assertion runs, which is
exactly the observed failure. The fix is to replace the fixed sleep with a bounded `waitUntil` poll
on `activityImeVisible`, mirroring the existing `imeShownInSystem()` poll. Filed as papercut
`pc_46cde2151a61` (tag `android`) — tooling friction, **not** a product bug or spec gap, because the
app's own behavior was never shown to be broken.
