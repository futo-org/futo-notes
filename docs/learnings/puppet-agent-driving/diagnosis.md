## 8. Diagnosis

*Do agents reproduce a reported bug in the app, and find its cause?*

**Two harnesses.**
- **`*-scenario.mjs`** reverts an old fix onto today's code and withholds the tests it touched as
  the answer key; those tests must fail before the agent starts. Only 29 of 133 recent fixes
  reverted cleanly.
- **`diagnose.mjs`** seeds a bug and gives a short report in a person's words. It grades two
  things: did the agent reproduce the bug in the app (judged from its tool calls), and did it find
  why.

Prompts that name the exact input turned out to measure reading, not reproducing.

| Batch | Runs | Reproduced | Cause right / partly / wrong | Cost a run |
|---|---|---|---|---|
| 09-24, no reproduce line | 12 | 7/12 | 7 / 1 / 4 | $0.77 |
| 10-06, no line, in the worktree | 7 | 0/7 | 6 / 1 / 0 | $0.32 |
| 10-06, no line, outside the checkout | 7 | 2/7 | 6 / 1 / 0 | $0.29 |
| 10-06, AGENTS.md paragraph | 7 | 4/7 | 6 / 1 / 0 | $0.33 |
| 10-06, "reproduce it…", round 1 | 7 | 7/7 | 6 / 1 / 0 | $0.45 |
| 10-06, "reproduce it…", round 2 | 7 | 6/7 | 6 / 1 / 0 | $0.47 |
| 10-06, visual bug with `screenshot` | 2 | 2/2 | 1 / 1 / 0 | $0.48 |

Over all 72 runs: 37 reproduced, 58 causes right, $37.80.

**Agents verify, but too narrowly.** Seven build-or-fix requests (09-22) ended "verify it works in
the app".
- Five of seven verified in the real app, and the evidence was real every time.
- What failed was scope: the agent checked that the reported symptom went away and stopped, leaving
  a sibling broken in two of three fixes (M17).

**Grading lessons.**
- **What the grader can see.** It must be able to open the images the agent read. Visual evidence
  counted for nothing until it could.
- **Keep the traces with the run.** The harness had deleted them before every run; it now keeps
  them.
- **Separate the real app from headless Chromium** when scoring "ran the app".
- **Leaks void results.** An answer once leaked into a skill.
