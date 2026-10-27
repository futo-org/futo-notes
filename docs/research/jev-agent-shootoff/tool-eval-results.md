## Results

Harness: `experiments/agent-skill/tool-eval/` (cookbook tool evaluation), the same 31
one-answer tasks and fixture vault as the `futo-puppet` rounds, `run.mjs --driver jev`. The
Claude arm is the recorded `revised2-sonnet` run (n=1, Sonnet, tool docs only). Same machine,
same desktop debug app.

| arm                              | strict | actions | wall  | cost  | per task |
| -------------------------------- | ------ | ------- | ----- | ----- | -------- |
| Claude + `futo-puppet` (revised2) | 28/31  | 60      | 329 s | $1.63 | 10.6 s   |
| Jev + `step` (jev-2)             | 26/31  | 52      | 48 s  | $0.02 | 1.5 s    |

Per Jev turn (82 turns): observe 299 ms, Jev 286 ms, 5.8k input tokens, 24.8 questions. Mean
`next` confidence 0.88. Every action landed on the first try except one 409 the stall detector
caught. `compare.mjs revised2-sonnet jev-2` has the per-task table.

Jev passed every driving and reading task: open, tabs, settings, sidebar, search, folders,
delete, theme, rename, bold, italic, replace, insert at end of line, undo, find count, create
note, a real click by ref, and the drag-select task (by `Select`, since the controller offers
`click` but not `drag`; the grader checks the string, not the gesture, so that pass is soft).

The five misses are the tasks that ask for something the controller refuses to offer:

| task                                          | why                                                                                 | class            |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| `batch`                                       | asks for one batched `do`; the design is one step per turn                          | by design        |
| `unknown-verb`, `missing-arg`, `wrong-screen` | ask to run an invalid move and report the refusal; only valid moves are on the menu | by design        |
| `cursor`                                      | needs `at`/`show`, queries the controller does not expose                           | missing evidence |

Misses fixed along the way, each a controller defect rather than a model one: observation
before the document loaded (empty doc, `Select` off the menu, Jev took `Insert`); `null` first
tab treated as an object so `app.tabs` was never an option; the task's own backticked words
offered as answers (`tabs` picked "tabs"); receipt diff noise (element refs, snapshot ids)
crowding the answer list; and Jev reading "afterwards" as the snapshot field named `after`.

## What this says

- **Model turns were the cost; Jev removes most of it.** The design record measured the app
  at ~0.27 s of a 6.6 s local-model turn. Here a whole turn is ~0.6 s, half of it the app.
  The next speed win is in `step`, not the model: `observe` snapshots the page each call.
- **Jev needs a menu, and building the menu is the work.** Everything Jev did right was a
  selection over candidates code enumerated. Where the controller lacked a candidate source it
  failed silently or stalled; where it offered distractors Jev took them literally. Every
  failure traced to the state or the options, none to the model refusing a well-posed choice.
- **The tool surface for a System One driver is different from an LLM's.** An LLM wants prose
  docs, refusals and batches. Jev wants one observation with everything in it, per-screen verbs
  with schemas (already there), closed argument sets with rubrics, and object ids on rows. The
  `futo-puppet` work that helped Claude most (ids on rows, gestures by ref) is exactly what made
  the candidate lists possible.
- **Not measured here:** phones (harness is desktop-only) and stability across runs (n=1).
