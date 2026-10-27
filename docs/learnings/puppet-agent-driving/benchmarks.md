## 6. Benchmarks

*How do you measure an agent driving an app, and what did we measure?*

**The sets.** The committed harness holds:

| Set | Size | What it is |
|---|---|---|
| Tool-eval (`tasks.json`) | 31 one-answer tasks | A small fixture, scored strict and lenient |
| Workflows (`workflows.mjs`) | 19 | Multi-step goals on a 5-note fixture, verified on the vault and `state` |
| Held-out (`heldout/`) | 28 desktop, 26 per phone | 497 notes in 43 folders, generated from a fixed seed; goals in a person's words; each verifier diffs the whole vault, so editing the wrong note fails |
| Editor (`heldout/editor-tasks.mjs`) | 17 desktop, 15 per phone | Tables, code blocks, lists, links, dividers; added after the Milkdown port |

The hard tier (24 tasks, 10 collapsed folders) and the first optimisation loop ran from an earlier
copy of the harness, which is not committed.

**Run real sessions.**
- **What a session is.** Each task is a `claude -p` from the worktree, so AGENTS.md and the skill
  load as they would for a person. `--setting-sources project` keeps personal instructions out.
- **Allowed and denied.** `just puppet` and read-only tools are allowed. Anything else is denied
  and counted, and subagents are disallowed because they outlive the run.
- **No peeking.** Reads of the harness and of this file are denied. A probe showed the rule also
  hides them from Grep and Glob.

**Accuracy saturates; count calls, errors and cost.** On the 31 tool-eval tasks, Sonnet was nearly
right from the start; the cost was in calls.

| Run (09-21) | Strict | Lenient | Calls | Time | Cost |
|---|---|---|---|---|---|
| baseline | 26/31 | 30/31 | 140 | 670 s | $2.34 |
| rows carry ids, `doc` numbers its lines | 28/31 | 31/31 | 60 | 329 s | $1.63 |

- **Clicking rows.** Two thirds of the excess calls went on opening notes by clicking rows that
  showed text but no id.
- **Saturation.** On the workflows, a deliberately degraded reference still passed 20/20, with 73
  calls against 62. One build's sweeps spread from 62 to 80 calls.
- **So the loop's bar** was at least 10% fewer calls at an equal pass, plus a green `just check`.
- **What the loop bought.** On the hard tier, one round cut calls from 164 to 78 by adding vault
  search, `doc {noteId}` and ids in receipts. A second round added nothing, except the composite
  verb rejected in §2.

**Judge on goals you never tuned on.**
- **Rules for the held-out set:** never tune on it, only classify its failures, and report
  aggregates.
- **What did not count.** Jev-alone scores on it (0/28, then 11/28) were not baselines, because no
  real run hands Jev a person's words.

**Check the checker.** Our own faults:

| Fault | Lesson |
|---|---|
| A verifier assumed browser tab order | Assert what the task asked for, never an app rule the spec does not state |
| An answer key expected `Untitled (1)`; the app makes `Untitled-N` | "The answer key was a guess made when the task was written, never checked against the app." Deleted. |
| A reference hardcoded a search-result index | References must find, not assume |
| An account limit mid-sweep was scored as failures | A limit must stop a sweep, not score it. The committed `run.mjs` does not handle limits yet. |
| The hook blocked a filtered `do`, and the `doc` chained after it | One held-out miss caused by the instrument |
| "5% filtered" | Claude counted `\|\|` fallbacks as pipes |
| "AGENTS.md is loaded twice" | False: a probe showed one AGENTS.md, one README and MEMORY.md |

**Held-out results** (passed, calls, cost per run):

| Version | What changed | Desktop | Android | iOS |
|---|---|---|---|---|
| v1 (10-01) | JSON receipts | 28/28, 224, $9.05 | 26/26, 197, $8.17 | 25/26, 211, $8.35 |
| v2 | text receipts and the hook | 28/28, 197, $8.91 | 26/26, 211, $8.53 | 25/26, 229, $8.98 |
| v4 | refusals print the fix | 28/28, 193, $8.64 | 26/26, 165, $7.56 | 26/26, 181, $7.86 |
| v7 | one-line `actions` | 28/28, 181, $8.45 | 26/26, 205, $8.11 | 26/26, 207, $8.40 |
| v9 (10-06) | after the Milkdown port | 28/28, 193, $6.09 | 26/26, 204, $5.97 | 26/26, 196, $5.95 |
| v11 | skill: finding a note | 28/28, 171, $6.02 | 25/26, 219, $6.03 | 25/26, 200, $5.75 |
| v12 (10-07) | rebased onto main | 28/28, 190, $5.98 | 26/26, 200, $5.67 | 26/26, 237, $6.23 |

Across the series a goal took 6.7–8.0 calls, 21–27 s and $0.22–0.33. The v11 phone misses were the
journal goal in §3.

**The cost drop after the Milkdown port came from Claude Code.**

| Desktop held-out | Claude Code | Turns a goal | Input tokens a goal | Cost |
|---|---|---|---|---|
| v7, before the port | 2.1.284 | 7.3 | 507k | $8.45 |
| v8, after the port | 2.1.289 | 7.3 | 392k | $6.15 |

- **Same turns, lighter turns.** The agents took the same number of turns, but each turn was
  15–18k tokens lighter.
- **It was Claude Code's prompt.** Turn 1, before any tool output, fell from 60.8k to 42.9k tokens
  when Claude Code updated. Our instruction files grew in the same window (AGENTS.md 18.0k → 21.7k
  characters).
- **Speed per goal was flat** (median, v4 → v9): desktop 18.5 → 16.3 s, iOS 20.7 → 22.5 s,
  Android 21.9 → 21.2 s.

**Editor set:**

| Version | Desktop | Android | iOS |
|---|---|---|---|
| v1 | 16/17 | 15/15 | 15/15 |
| v2 | 17/17 | 15/15 | 15/15 |

About $0.20–0.25 a goal. Both misses were the agent's: a `[[roadmap]]` link that matches four
notes and was never checked, and a second code block where a line was asked for.

**Models:**

| Model | Set | Result | Calls | Time | Cost |
|---|---|---|---|---|---|
| Sonnet 5.5 medium | held-out, desktop (v9) | 28/28 | 193 | 499 s | $6.09 |
| Haiku 4.5 | same | 27/28 | 301 | 947 s | $3.54 |
| Haiku 4.5 | editor, desktop | 13/17 | 341 | 1186 s | $3.68 |
| Opus 5.5 | 3-goal pilot | 3/3 | 25 | 85 s | $1.60 |

- **Haiku** made 56 and 80 tool errors, against Sonnet's 11 and 4. Its misses were its own: a fast
  write that nested a task, and a goal misread as editing app source.
- **Sonnet 5.5 at medium** was chosen after a 4-goal pilot passed 4/4.

**What running the sets found.**
- **Fixed after the 09-25 held-out build:**
  - folder moves and renames answering "no such folder" inside a collapsed parent;
  - move and search verbs answering before they landed;
  - `OpenNote` answering before the switch.
- **Fixed overnight on 10-05, each with a test:**
  - an iOS crash on `MoveNote`, from a struct put into the receipt;
  - `Press ArrowRight` over a selection skipping a character;
  - a divider after a list item returning 500;
  - note names with apostrophes refused;
  - the row check firing ahead of an open dialog;
  - phone `answer` accepting any string;
  - a joined `do 'Verb {...}'` misparsed;
  - an iOS test that scanned only the first 900 characters of a source file.
- **Found without a recorded fix:** the iOS find bar dropping typed characters. Separately, the
  phones' `CreateNote` creates at the root while a folder is open; the verb now takes a `folder`
  argument, but the default is unchanged.

**Where the time goes: both levers count.**
- **Faster calls halved the time outside the model.** Comparing the old way (main as of 09-11)
  with the tool (09-23) across the dev-loop sessions, everything outside the model fell from 242 s
  to 127 s. Before that, slow calls had been the bottleneck: accessibility taps at 2.6–8.6 s, phone
  refusals that waited 5 s, and App Nap hangs of up to 180 s.
- **The model is most of a session.** In the same sessions, model thinking was 1,457 s and
  1,549 s, 85–97% of each session. Inside diagnosis runs, Claude spent 2.7–6.3 s deciding before
  each call that ran in 0.6–0.7 s.
- **So fewer turns save the most per change.** The same task done in fewer, surer calls (§2, §3)
  cuts model time as well as tool time.
