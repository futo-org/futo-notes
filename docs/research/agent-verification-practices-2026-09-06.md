# Agent development and verification practices

Researched 2026-09-06 against public primary sources and a small sample of firsthand Reddit
discussions. Repository observations refer to `origin/main` at
`6d59965d33281f3532ac68002a3b2952dd5e7095`, before changes from this investigation.
This note records the research baseline. See the [implemented slice and validation](../plan/agent-verification-2026-09-06.md) for what changed afterward.

The most useful investment is a reliable path from a fresh worktree to a running, identified app,
then from that app to evidence the agent and Justin can both inspect. FUTO Notes already owns much
of this machinery. Connecting it and making failure states explicit is more useful than adding
another general agent framework.

## What the repository already provides

| Existing owner                                                                                                            | What to preserve and build on                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [CONTRIBUTING.md](../../CONTRIBUTING.md), [justfile](../../justfile)                                                      | Pinned Node, workspace dependency installation, native build recipes, and optional skill/MCP setup.                         |
| [slot.mjs](../../scripts/lib/slot.mjs), [verify skill](../../.claude/skills/verify/SKILL.md)                              | Stable worktree ports, claimed simulator/emulator pools, isolated sync servers, and platform-specific driving instructions. |
| [qa-target.mjs](../../scripts/qa-target.mjs), [qa-shot.mjs](../../scripts/qa-shot.mjs)                                    | Desktop process/data identity checks and screenshots that avoid activating the user's window.                               |
| [remote testing](../remote-testing.md), [remote-test.mjs](../../scripts/remote-test.mjs)                                  | Remote prerequisite inspection, checkout locking, SHA checks, exit propagation, and explicit limits on Linux evidence.      |
| [Playwright configuration](../../playwright.config.ts)                                                                    | Failed-run traces, videos and screenshots; `PW_RUN_ID` separates test output directories.                                   |
| [cross-platform sync harness](../../tests/cross-platform-sync.mjs), [desktop smoke](../../tests/desktop-smoke.mjs)        | Existing real-app test owners to extend with focused scenarios.                                                             |
| [papercuts workflow](../agents/papercuts.md), [QA postmortem](../learnings/qa-pass-2026-08-10-silent-green-postmortem.md) | Persistent records of tool friction and examples of checks that stayed green while behavior broke.                          |

Three concrete inconsistencies appeared during inspection. The verify skill's scope detection uses
`HEAD~1` plus dirty changes, so it can miss earlier commits on a feature branch. Several verification
commands pipe through `head`/`tail` without establishing `pipefail`, contradicting root M11/M20.
The isolation prose promises that other sessions never share a slot, while the owner hashes paths
into only 50 slots: deterministic assignment cannot guarantee uniqueness. Recorded as
`pc_067ccfa245b8` and `pc_c6fc32e50819` in the papercut log. These observations concern tooling and
documentation, not a verified product defect.

## Relevant primary sources

| Source, accessed 2026-09-06                                                                                                                                             | Finding and implication                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI: local environments](https://learn.chatgpt.com/docs/environments/local-environment)                                                                             | Codex desktop local environments can run setup when creating worktrees, expose common actions, and use platform-specific scripts. Share the generated configuration in the repository; delegate commands to `just`. This is a desktop-app capability, not an automatic hook for every manually created Git worktree. |
| [OpenAI: Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)                                                                                      | Worktrees can be tested in place when dependencies are prepared. `.worktreeinclude` copies selected ignored files only into local managed worktrees; it excludes source symlinks and does not cover manual or remote worktrees. It cannot replace a portable bootstrap command.                                      |
| [Git: git-worktree](https://git-scm.com/docs/git-worktree)                                                                                                              | Worktrees have separate working directories and indexes but share repository state. Runtime ports, databases, app profiles, and devices still need their own isolation.                                                                                                                                              |
| [Anthropic: Claude Code best practices](https://code.claude.com/docs/en/best-practices)                                                                                 | Supply executable checks and visible evidence, keep enduring project instructions concise, and put occasional workflows in skills. This supports translating recurring failure-prone commands into tested tools instead of accumulating longer reminders.                                                            |
| [Playwright: best practices](https://playwright.dev/docs/best-practices)                                                                                                | Verify user-visible behavior, isolate tests, and use locators and assertions that wait for observable conditions. Apply these ideas to the existing test owners; browser coverage still has the repository's native-engine limits.                                                                                   |
| [Playwright: trace viewer](https://playwright.dev/docs/trace-viewer)                                                                                                    | Traces include action history and DOM inspection. `retain-on-failure` records then discards successful traces and works without retries. FUTO Notes already chooses this mode with zero retries; preserve it and improve artifact discovery.                                                                         |
| [Playwright: WebView2](https://playwright.dev/docs/webview2), [Chrome: Android WebView debugging](https://developer.chrome.com/docs/devtools/remote-debugging/webviews) | Debug protocols can target actual embedded engines. WebView2 testing needs a separate user-data directory per concurrent instance; Android WebView inspection requires debugging enabled in the app. A browser emulation preset is not evidence about native shell or keyboard behavior.                             |
| [Microsoft Aspire: build, run, observe](https://devblogs.microsoft.com/aspire/agentic-dev-aspirations/)                                                                 | The product team describes structured CLI lifecycle/status output and local telemetry as inputs to agent verification. Borrow the interface pattern for current FUTO tools; adopting Aspire itself is not necessary.                                                                                                 |

## Six proposed improvements

These are recommendations inferred from the sources and repository inspection, ordered by likely
benefit relative to implementation cost. Suggested command names below are conceptual, not current
recipes.

### 1. Make worktree readiness one discoverable operation

Add an idempotent bootstrap and a read-only readiness report, both reachable through `just`.
Bootstrap should activate the pinned tools, run the existing install/link recipes, and prepare
only the generated inputs needed for the requested platform. The report should identify the root,
base SHA, host, dependencies, tool versions, port ownership, available verification surfaces, and
the exact next command when something is missing. Reuse `slot.mjs`, `qa-status`, and remote doctor
logic rather than duplicating their decisions.

A Codex local-environment action can call the same recipe. Make repo-owned verification instructions
discoverable from both Codex and Claude without depending on ignored third-party skill symlinks.
Keep machine-specific secrets and production settings outside automatic file copying.

**Acceptance:** a fresh worktree reaches its first relevant test through documented commands;
running setup twice preserves local configuration and identifies any unavailable platform leg.

### 2. Make verification scope and outcome executable

Replace the skill's ad hoc changed-file shell snippet with a small tested planner that accepts an
explicit base ref and includes the complete branch diff, staged changes, unstaged changes, and
relevant untracked files. The nearest manuals remain authoritative about which chains run. Print
the resolved base and categorized paths so the scope is reviewable before expensive work starts.

Run commands without status-masking pipelines. Report `PASS`, `FAIL`, `BLOCKED`, `REFUSED`, and
`VOID` distinctly, following the remote runner's existing semantics. Where a suite can match zero
tests, assert the intended scenario count rather than treating an empty selection as proof.

**Acceptance:** fixtures cover a two-commit branch, dirty/untracked tests, a failing command with
truncated display output, and an unavailable native platform. None can silently become a pass.

### 3. Put every run's evidence behind one manifest

Build a lightweight run record around existing artifacts: command and exit status, source SHA and
dirty-content identity, host/OS/engine, build identity, verified target, fixture identifier, timestamps,
scenario counts, and links to logs, screenshots, traces, and native result bundles. Mark results
invalid when their source changed during execution. Capture identity before and after the run.

`PW_RUN_ID` already separates trace directories, but the JSON reporter still writes to
`test-results/results.json` and HTML to `playwright-report`. Preserve or copy those into the same
run record so the next invocation cannot overwrite the evidence being reviewed. Capture screenshots
through the safe existing target helpers. Treat a useful screenshot as one piece of evidence;
persisted note state and assertions supply the behavioral proof.

**Acceptance:** a failed run followed by a successful rerun retains both records, and Justin can
open either with its exact reproduction command and coverage limits.

### 4. Make host and device capabilities visible before scheduling QA

Expose a shared inventory of what each configured host can currently prove: portable checks,
WebKitGTK desktop, macOS WKWebView, iOS simulator/device, Android emulator/device, and Windows
WebView2. Include claim ownership, build/binding freshness, debug endpoint identity, and display or
device readiness. Run host-local drivers over authenticated SSH/Tailscale using dedicated worktrees
and existing claim mechanisms. Keep loopback debug endpoints behind that connection.

The existing remote runner deliberately targets Linux; a Mac execution path needs a separate
capability policy, not a bypass of its refusal list. For paint/animation QA, provide a visible test
surface that does not steal the user's focus. `qa-shot.mjs` already documents why occluded-frame
timing cannot be established by a background screenshot.

**Acceptance:** the same feature request produces an explicit list of runnable and unavailable
platform checks; stale builds or unclaimed targets fail before any interaction.

### 5. Package a few real-app journeys with reusable synthetic data

Make high-value flows repeatable from an empty test vault: create/edit/relaunch/persistence,
rename/backlinks, deletion during pending work, and two-client offline edits followed by sync.
Extend the current desktop and sync harnesses and reuse their fixtures and canonical APIs. For
native keyboard or gesture regressions, add the matching scenario to that platform's existing
driver rather than claiming web-browser equivalence.

Use application readiness and observed state changes as waits. Assert persisted data and final
visible state; record the action trace. Seed through existing setup APIs, then exercise the actual
workflow. Test-only JavaScript must not repair application behavior before the assertion. The
existing failure-first regression rule supplies a useful check that the scenario can catch its bug.

**Acceptance:** a named journey runs from a fresh isolated fixture, fails against its known broken
case, passes after the fix, and leaves enough evidence to replay the failure.

### 6. Finish with a small evidence-linked handoff and feedback loop

Generate a concise handoff from the run record: what changed, what ran, what remains uncovered,
and how to reopen the tested app or artifacts. Capture recurring tool failures in the existing
papercut log and promote a lesson into instructions only when it affects repeated work. Prefer a
tested command fix when the lesson is mechanically enforceable.

Track setup time, time to first relevant test, time from failure to reproduction, invalid runs,
and human interventions required to obtain evidence. Use a short sample before and after each
tooling change; this would test whether the setup actually makes collaboration easier. Keep task
history retrieval separate from these operational records, and save distilled workflow lessons
rather than private conversation transcripts in the repository.

**Acceptance:** the next agent can resume a failed verification from its handoff without asking
Justin to reconstruct the worktree, fixture, command, or missing platform coverage.

## Firsthand public discussions: anecdotes, not technical authority

These discussions suggest useful failure modes to test for. They are self-selected reports,
some replies promote the author's tools, and they do not establish prevalence or measured gains.
Their content was read on 2026-09-06; relative ages on Reddit are not treated as exact event dates.

- In [a discussion about parallel agents and running apps](https://www.reddit.com/r/ClaudeAI/comments/1vx0lkt/if_you_run_multiple_ai_agents_on_the_same_repo/),
  the original poster describes worktrees isolating code while shared app instances still block
  parallel testing. Individual respondents report separate runtime data, ports, and leased
  simulators. This matches FUTO's existing isolation owners; it supports making them easier to use,
  not replacing them with the products mentioned in replies. The automated bot summary was not
  used as evidence.
- In [a browser-debugging account](https://www.reddit.com/r/ClaudeAI/comments/1r8fz12/chrome_devtools_mcp_creates_a_closed_feedback/),
  the author reports that direct browser inspection removed manual screenshot copying and enabled
  an inspect/edit/reload cycle. This motivates reliable artifact access. Their criticism of one
  Playwright setup does not establish that another browser tool is generally superior.
- In [a report of tests modifying the app at runtime](https://www.reddit.com/r/ClaudeCode/comments/1rug14a/claude_wrote_playwright_tests_that_secretly/),
  the author describes a green generated E2E suite whose injected JavaScript repaired broken UI
  before assertions. This is an anecdotal counterpart to FUTO's documented silent-green failures,
  and a reason to inspect test purpose and require a failing regression.
- In [a Codex worktree report](https://www.reddit.com/r/codex/comments/1sjoiii/codex_app_worktrees_actions_etc/),
  the author describes losing track of the active checkout when testing. This is a historical
  account of their experience, not a claim about current Codex behavior. Explicit root/build
  identity in every run remains useful independently of that report.

## Limits and first slice

This was bounded public research and repository inspection. It did not inspect private conversation
history, log into the MacBook, install competing frameworks, benchmark tools, or run a device QA
journey. Remote capability and performance proposals need measurements on the actual hosts.

Start with readiness reporting and the scope/status defects, then add one evidence manifest around
an existing test command. Expand into native host orchestration only after a real missing-capability
case identifies the next useful integration. Preserve all dev/prod guards, target identity checks,
native-shell requirements, and existing platform-specific verification obligations.
