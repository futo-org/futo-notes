---
name: bugfix
description: Fix bugs with a test-first approach that prevents regressions. Writes a failing regression test immediately, then diagnoses the root cause, applies the minimal fix, and verifies. Use this skill whenever the user reports a bug, pastes an error or stack trace, says "fix this", describes unexpected behavior, mentions something that "used to work", or asks you to debug an issue — even if they don't explicitly say "bug". Also use when the user wants to investigate flaky behavior or track down why something is broken.
---

# Bugfix

Fix bugs so they stay fixed. The core discipline: write a test that fails *first*, before you even fully understand the root cause. This proves the test catches the bug and gives you a concrete reproduction to work against. Then dig into the why, fix it, and confirm the test goes green.

## The workflow

### 1. Understand the symptom

Get clear on what's broken — just enough to reproduce it, not to explain it yet.

**From an error/stack trace:** Grep for the error message in the codebase. Read the source at the relevant line. Check `git log --oneline -5 -- <file>` to see if a recent change caused it.

**From a behavior description ("X does Y instead of Z"):** Identify which code path is involved. Read it enough to know what inputs trigger the wrong behavior.

**From a regression ("this used to work"):** Use `git log` on the relevant files to find when the behavior changed.

**If the bug isn't obvious from the report:** Run the app, hit the endpoint, execute the function — whatever it takes to see the failure yourself. Don't proceed until you've confirmed the symptom.

### 2. Write a failing test immediately

Before investigating the root cause, write a test that demonstrates the broken behavior. The test should assert what the *correct* behavior is — it will fail right now because the bug exists, and that's exactly what you want.

Don't overthink it. A naive test that exercises the buggy code path and checks for the right answer is fine. You can refine it later if you discover the root cause is different from what you expected. The point is to lock in a concrete reproduction *now*.

Choose the test type based on where the bug lives. Refer to the project's test requirements table in AGENTS.md for where tests live and how to run them:

| Bug location | Test approach |
|---|---|
| Pure function / data transform | Unit test |
| API endpoint / request handling | Integration test with real route |
| Multi-component interaction | Integration test exercising the full path |
| State machine / sync protocol | Multi-client or stateful scenario test |
| UI behavior / rendering | Playwright E2E or visual screenshot test |
| Race condition / timing | Stress test or chaos test with concurrent ops |

Name the test so a reader understands what bug it prevents: `"rejects sync when timestamp is string instead of number"` not `"handles bad input"`.

Run the test and **confirm it fails**:

```bash
# Run the new test — it should fail
pnpm run test:unit -- --reporter verbose 2>&1 | tail -20
```

If it passes, something is wrong — the test doesn't exercise the bug. Revisit before continuing.

### 3. Find the root cause

Now dig deeper. You have a failing test to anchor your investigation against.

Surface-level fixes (null checks, try/catch wrappers, race condition workarounds) make symptoms disappear without addressing *why* they happened. The root cause is the why: a missing validation, an incorrect type assumption, an invalid state transition, an off-by-one.

Dig until you can explain the bug in one sentence: "The sync client sends `lastSyncTimestamp` as a string but the server compares it numerically, so equality checks always fail."

If the root cause turns out to be different from what you initially tested, update the test to target the actual root cause more precisely. Run it again to confirm it still fails.

### 4. Apply the minimal fix

Fix the root cause. Nothing else. Don't refactor neighboring code, rename variables, add docs, or "improve" things in the same change. A bug fix should be reviewable in under a minute — the smaller the diff, the more confidence that it fixes exactly what it claims.

If you spot other issues nearby, note them but don't fix them here.

### 5. Verify

Run the regression test — it should now pass:

```bash
# Same test from step 2 — should now be green
```

Then run the broader test suite to make sure you didn't break anything else. Use the project's verification chain from AGENTS.md — pick the chain matching what you changed. At minimum:

```bash
pnpm exec tsc --noEmit 2>&1 | head -30          # Type check
pnpm run build 2>&1 | tail -20              # Build
# + relevant test suite(s) for the area you changed
```

If anything new is broken, fix it before moving on.

### 6. Check for siblings

The same bug pattern often exists in more than one place. Grep the codebase for the same risky pattern:

```bash
# Example: the bug was an unchecked .settings access
rg "user\.settings\." --type ts -l
```

If you find siblings, mention them to the user. Don't silently fix them — they're separate bugs and deserve their own tests. But flagging them now saves the user from discovering them the hard way.

## Report

Summarize concisely:

- **Root cause:** one sentence explaining why the bug happened
- **Fix:** what you changed and why
- **Regression test:** where it lives and what it asserts
- **Siblings:** related instances of the same pattern, or "none found"
- **Verification:** which suites you ran, pass/fail results
