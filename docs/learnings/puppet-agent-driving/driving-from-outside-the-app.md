## 1. Driving from outside the app does not work

*Why build a listener inside each app instead of using existing drivers?*

**Outside drivers report success when nothing happened.**
- **`axe` on iOS.**
  - On 09-16 the first tap after a launch did nothing, twice, while reporting success.
  - It could not hold Shift or Cmd: Cmd+A typed `a`.
  - Swipes were ignored.
  - On 09-23, with Xcode 27's DeviceHub open, the simulator rejected every `axe` tap ("already
    have a main display digitizer") while `axe` still printed success. That morning's agent results
    were void.
- **The desktop MCP bridge.** Its DOM clicks missed Svelte 5's delegated handlers.

Neither a DOM click nor a direct verb can reproduce a bug that only shows up in a real press
sequence.

**They are also slow.**
- An accessibility-tree tap took 2.6–8.6 s, against 30–91 ms for a typed action.
- Driving iOS through accessibility taps took about 36 s for 1.2 s of app work. Sonnet, given the
  first CLI, did the same flow in one batch in 8.5 s (09-14).

**A listener inside the app, with typed verbs, is faster and surer.** That is how Shopify does it:
a debug listener inside the real app publishes the verbs for each screen. The app is not run
headless. The first A/B (09-16) gave one prompt to both trees: on iOS, make a note, then select
from its top to the end of a code block.

| | This branch | `main` |
|---|---|---|
| Result | Selected | Stopped at the opening fence, 3 of 3 attempts |
| Time / calls / tokens | 213 s / 14 / 114k | 1162 s / 88 / 225k |

Six of the branch run's seven steps still fell back to `axe`, because no verb could create a note
or insert text yet. Once verbs covered setup, the whole task was one `do` batch: 0.35 s on desktop,
0.78 s on iOS.

**Which outside input tool sits underneath does not matter.** We compared `agent-device` with `axe`
(09-18): same simulator and coordinates, judged by the app's own event log rather than exit codes.

| | `axe` | `agent-device` |
|---|---|---|
| Tap, 15 tries | 9 landed, median 1076 ms | 9 landed, median 1173 ms |
| Hold, 5 tries | 3 landed | 4 landed |
| Drag, 5 tries | 0 landed | 0 landed |

`axe` stayed, but only inside the CLI's phone gestures. Neither tool can drag-select text, because
a finger drag scrolls.
