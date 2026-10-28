### Ranked improvements

0. The `jev+claude` harness arm is the loop an agent would run by hand. What it does not
   measure is the agent's _understanding_ of the account, only whether it can answer the
   `need:` line; the scenario tier below measures the former.
1. Measure the delegation where it matters: a real bug scenario
   (`experiments/agent-skill/run-scenario.mjs`) with the skill loaded, graded on whether the
   agent reaches for `drive` and reasons correctly from the account. Nothing above measures that.
2. `two-untitled`: give `editor:new` a rubric or a candidate the model can act on (SetTitle or a
   write are the only sensible moves; offer nothing else).
3. Phones: done for iOS in round seven; Android needs `observe` and `notes` on its listener and a
   Compose verb registry before the same sweep can run.
4. `background-tabs` taught the general lesson: a workflow verifier must assert what the task asked
   the driver to do, never an app rule the spec does not state. Where successive background tabs
   land stays a product question; the check no longer depends on it.
