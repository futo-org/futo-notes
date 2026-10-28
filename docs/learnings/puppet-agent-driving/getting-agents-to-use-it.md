## 5. Getting agents to use it

*Once the tool worked, why didn't agents use it, and what changed that?*

**A better doc only helps if it is read.**
- **When read, it worked.** Rewriting the reference with a worked example first (117 → 330 lines)
  cut one iOS task from 323 s and 36 calls to 151 s and 22 (09-17; Opus, one run each).
- **It was not read.** Neither test agent invoked the skill that held it. On 10-01, 0 of 84
  held-out sessions opened `references/*.md`. "Our agents were ignorant, not disobedient."
- **Outside studies don't help here.** Published studies of AGENTS.md files (arXiv 2602.11988,
  2605.10039) measure whether agents follow what they read. That was not our problem.

**At first, agents ignored the tool entirely.** Five Sonnet runs (09-17) got symptom-only prompts
ending "Reproduce it, find the root cause, and fix it.":

| Outcome | Runs |
|---|---|
| Reproduced first | 0/5 |
| Used the CLI | 1/5 (and it hit the `adb forward` bug) |
| Ran the real app | 1/5 |
| Found the right cause | 3/5 |

`just check` passed all five, including three non-fixes and a regression.

**The instruction that owns the moment wins.**
- **What happened.** Making the tool its own skill, with a trigger, changed nothing: the treatment
  agent loaded the older `bugfix` skill instead, and made the identical wrong fix.
- **Why.** That skill ran the app only "if the bug isn't obvious from the report", and had the
  test written first, so the test encoded the agent's guess.
- **The fix.** Deleting it (09-18) left a single skill for driving the apps.

**Agents start the app only if it is already running.** In 13 cold-checkout runs, no desktop agent
started the app. They wrote Playwright specs instead: one command that exits, rather than a
long-running dev server. With the app pre-launched, three scenarios run in sequence gave:

| | Tool documented as a reference file | With all the instruction fixes |
|---|---|---|
| Time | 2571 s | 1451 s |
| Cost | $12.73 | $6.90 |
| Right cause | 2/3 | 3/3 |

Most of the gain came on the hardest scenario. Its second run was the first desktop agent to drive
the running app (17 calls).

**Suggestions don't steer Claude.**
- **Suggested `drive` went unused.** Told it could hand driving to Jev with `drive`, Claude did so:
  - 0 times in 124 commands;
  - 0 times in 7 dev-loop sessions;
  - 0 times in 7 diagnosis runs.
- **Putting it first in the skill** got 2 calls in 7 runs. Neither helped, and those runs were
  slower: 43.7 minutes against 36.1.
- **A gate in the CLI** then forced it, and Claude set the opt-out variable itself, unasked,
  6 times. Mason: "Suggestions to Claude are not enough to get it to behave."

**Ask for the reproduction in the request.**

| Diagnosis prompt | Bugs | Reproduced |
|---|---|---|
| 09-24: ended "Can you figure out what's going on?" | 7 | 5 of 7 |
| 10-06, after the Milkdown port: same style, a different seven bugs | 7 | 0 of 7 (2 of 7 outside the checkout) |
| 10-06, same bugs, plus "Reproduce it in the running app first" | 7 | 13 of 14 |

- **Without the line,** the 10-06 agents went straight to `rg` and never loaded the skill.
- **A paragraph in AGENTS.md** instead got 4 of 7. Mason moved the instruction into the request,
  and into a future bug-hunting skill: "the reproduction should happen in our own user prompt rather
  than in agents.md".
- **The cost of reproducing.** Runs became about 70% slower and 50% dearer, while the cause was
  found 12 of 14 times either way. Its value is the evidence.

**Two more measures, untested on their own:**
- **Inline commands.** One run's first move was to delegate a grep to a subagent, so it never
  loaded any skill. AGENTS.md §9 now carries the first commands inline, and says to load the skill
  first.
- **A gate on instruction files.** `check-puppet-first` fails any instruction file that teaches
  another driver.

Neither was A/B tested on its own.

**The instruction arms.** Each arm was one real commit, from the draft history that local
`backup/` branches keep. The scenarios differed between arms, so this is not like for like.

| Arm | What changed | Runs | Right cause | Ran the app | Reproduced first |
|---|---|---|---|---|---|
| baseline | tool documented as a reference file | 6 | 4/6 | 1/6 | 2/6 |
| treatment | own skill, trigger, gate | 5 | 3/5 | 1/5 | 2/5 |
| routed | `bugfix` made to look at the failure first | 2 | 2/2 | 0/2 | 0/2 |
| current | all of the above, spec as the contract | 3 | 3/3 | 1/3 | 2/3 |
| desktop-input | current plus real click and drag | 4 | 2/4 | 2/4 | 2/4 |
| single-skill | `bugfix` deleted | 2 | 1/2 | 1/2 | 1/2 |
| old | main at the fork, no tooling | 7 | — | 3/7 | 1/5 |
| drive | `Type`/`Press`; `drive` documented | 7 | — | 5/7 | 1/5 |
| drivefirst | skill routes reproductions to `drive` | 7 | — | 5/7 | 3/5 |

**The old way against the tool,** on four finished pairs. The old way reached the app through
hand-written WebSocket scripts.

| | Old way | The tool |
|---|---|---|
| Time | 28.3 min | 27.9 min |
| Cost | $8.73 | $7.82 |
| Reached the real app | 2 of 4 | 3 of 4 |
| Claims backed by evidence | 2 of 4 | 3 of 3 |

Both missed the same sibling paths (M17).
