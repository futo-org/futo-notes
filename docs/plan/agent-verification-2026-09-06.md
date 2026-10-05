# Making agent work easier to verify

Date: 2026-09-06. Worktree: `../futo-notes-agent-verification-20260906`.
Branch: `chore/agent-verification-20260906`, created after fetching `origin/main`
at `6d59965d33281f3532ac68002a3b2952dd5e7095`.

## Recommendation

Give each task a reproducible path from checkout to evidence: identify the code,
establish the required tools, claim the app/device, run a user journey, inspect
the result, and leave a replayable record. FUTO already has most of the individual
pieces. The highest-value changes connect those pieces and close the places where
an agent can obtain a misleading result.

September 8 follow-up: Justin deferred sync QA server ownership as a papercut and
requested evidence retention, repeatable setup/Mac access, and complete journeys.
Those are implemented through the [worktree verification commands](../agents/verification-runs.md).
The roadmap below preserves the original recommendations; it is not an instruction
to implement the deferred server change.

## Evidence reviewed

- Current main's setup docs, justfile, verification skill, slot/claim/target tools,
  remote runner, Playwright configuration and committed papercuts.
- The [earlier agent-DX audit](https://gitlab.futo.org/futo-notes/futo-notes/-/blob/42226bcb485b075922c7be87557255ea6f1df8ce/docs/plan/agent-dx.md)
  on `chore/agent-dx`. Its proposals were a useful starting point; its historical
  session, disk and timing totals were not remeasured or treated as current facts.
- Relevant FUTO Notes prompt histories on Linux and the MacBook over authenticated
  Tailscale SSH, plus selected Mac assistant reports about native editor QA and
  release verification. This was a targeted sample, not an exhaustive transcript
  analysis. Raw conversations were not copied into the repository.
- [Public research](../research/agent-verification-practices-2026-09-06.md): official
  documentation plus four clearly labeled firsthand Reddit anecdotes. The public
  accounts suggest failure modes; they do not establish prevalence or tool superiority.

The histories repeatedly ask for worktree isolation, testing on the actual simulator
or phone, and visible proof. One September 1 Mac report distinguished faster note
opening from a later failure when the user tapped into the editor. Another September 4
report verified native suites after combining fixes. Those are good examples of the
required scope: exercise the complete user action and verify the integrated code.

## Improvements implemented in this branch

### Read-only orientation

`just orient` now reports checkout, branch/SHA, host, Node version/pin, tool paths,
dependency/build-directory presence, port bases and registered worktrees sharing
the slot. `just orient --json` exposes the same information for other tools.
It needs no installed npm packages. `--base <ref>` selects a comparison base.

Its change inventory includes the complete branch since the merge base, staged
changes, unstaged changes, deletions and untracked files. Filenames are obtained
with Git's NUL-delimited output. It refuses an unavailable base instead of quietly
falling back to the last commit.

This is an inventory, not a readiness gate or evidence receipt. It does not test
ports, claim devices, validate an installed binary, detect concurrent source edits,
or prove dependencies are fresh. Missing tools are reported without installing them.
The nearest manuals continue to own test selection.

The first real run found six other registered worktrees sharing this worktree's
slot 47. Registration does not mean they are active, but it disproves the old
playbook's guarantee that worktree slots never collide.

### Corrected verification instructions

The [verify skill](../../.claude/skills/verify/SKILL.md) now uses the complete change
inventory, preserves command exit statuses, calls the actual Playwright recipe,
and includes the existing Swift Testing suite. It directs agents to the nearest
owner's complete chain, condition-based waits, real-engine checks and explicit
code/target/evidence identity in the handoff. Both last-commit-only scope snippets
were removed. The finite-slot and sync-server limitations are stated explicitly.

## September 8 follow-up verification

- `just verify-run check`: passed on Linux, including 1,846 unit tests and 381
  editor tests; nine existing unit skips remain.
- `just verify-run test-cross-platform --no-android`: all 33 desktop scenarios
  passed, including offline accumulation and peer deletion. Six Android scenarios
  were explicitly skipped. The bundle retains sync results, server logs/databases
  and both verified desktop instances.
- `just verify-run test-e2e`: both Chromium P0 regressions passed; JSON and HTML
  reports landed inside the unique evidence directory.
- `just verify-run test-desktop-journeys`: both save/relaunch and rename/backlink
  journeys passed on Linux WebKitGTK and Mac WKWebView. These use bridge/editor
  hooks; they do not establish native keyboard or visual-painting behavior.
- Public CLI tests cover retained red/green bundles, source-change invalidation,
  literal command arguments, platform preflight and refusal of unsafe restart
  storage. The Mac caught stdout contamination from fnm activation; that test
  failed before the stderr fix and all seven new tests now pass there.
- Mac setup completed twice from plain SSH, and iOS prerequisites passed. AXe is
  unavailable in the tested tool environment: the iOS story recipe now fails
  before a native build. No iOS/Android device journey was run in this follow-up.

Reports are retained under `verification-runs/` in each task worktree; Mac reports
are also copied into the Linux worktree's `verification-runs/mac-20260908/`.
Evidence is local and gitignored. The commands and interpretation are documented
in [worktree verification](../agents/verification-runs.md).

## Original roadmap and follow-up status

The follow-up adds `just verify-run`, `just setup`, the noninteractive `dev-env.sh`
entry point, native build preflights and `just test-desktop-journeys`. Playwright and
desktop sync artifacts use per-run storage. Linux desktop save/relaunch and
rename/backlink journeys pass; a separate Mac worktree completed setup twice and
passed iOS prerequisites. Native keyboard and device result collection remain
platform-specific; they are not implied by setup or desktop results.

| Priority | Improvement                                                                                                                                                                                                                                 | Concrete acceptance test                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First    | **Enforce sync QA server ownership.** `cmdServerStart` currently accepts a live slot PID without checking `meta.worktree`; `serverStop` also acts by slot. Add atomic claims and verify owner/process identity for start, stop and release. | Two colliding worktrees race to start; only one wins. The loser cannot reuse, stop or drop the winner's state, including after PID reuse. Run in isolated test state.                                                 |
| Next     | **Preserve one evidence bundle per run.** Reuse existing logs, traces, screenshots and native results; record SHA plus dirty-content identity, engine, target, fixture, command and exit status.                                            | A red run followed by a green rerun leaves both reports inspectable. A changed source/build cannot inherit the old PASS. `PW_RUN_ID` already separates traces; fixed JSON/HTML report paths still need attention.     |
| Next     | **Add repeatable worktree and host bootstrap.** One `just` entry point should activate pinned tools, install workspace dependencies, check platform prerequisites before Rust builds and print the first relevant test command.             | A fresh manual worktree and an app-created worktree both reach a relevant test. A second setup preserves local configuration. Missing Android SDK/JDK or iOS tooling fails before an expensive build.                 |
| Next     | **Make remote Mac QA a supported path.** Establish a non-interactive tool environment and expose host/device capabilities; run host-local drivers through SSH with claimed devices and separate worktrees.                                  | Linux can request an iOS check with the tested SHA, claimed simulator and result bundle identified. Missing display, SDK or device readiness is reported before a build. Keep debug endpoints on loopback behind SSH. |
| Then     | **Package a few complete user journeys.** Extend existing harnesses with synthetic fixtures for create/edit/relaunch, rename/backlinks, delete during pending work and offline edits followed by sync.                                      | Each journey asserts visible behavior and persisted data, fails against its known broken case, and can be replayed from the saved fixture. Add native keyboard/lifecycle checks on their actual platforms.            |
| Then     | **Make handoff and lifecycle review cheap.** Show evidence location, last tested code, owned resources and exact resume commands; add a bounded CI waiter and a regular papercut review.                                                    | A successor resumes without asking Justin to reconstruct state. Worktree cleanup is a reviewable inventory; age or a clean Git tree never authorizes deleting builds or evidence.                                     |

The sync-server finding is code-inspected, not reproduced by touching another
session's server. It is logged as major papercut `pc_980ab7becd04` and remains
unfixed in code. The orientation command makes possible collisions visible but
does not close the race. Device claims and desktop target checks remain in place.

The Mac smoke check confirmed authenticated access and exposed an immediate bootstrap
problem: its plain SSH shell could not find Node, `just` or `pnpm`; invoking
`/opt/homebrew/bin/node` explicitly ran version 26.5.0 against a 22.23.1 repo pin.
That does not establish how an interactive terminal is configured. Papercut
`pc_bd8eeb546f89` records the remote-shell gap. In the September 8 follow-up, the
bootstrap installed fnm and pinned Node on the Mac without changing shell profiles
or the global Node default; rerunning setup reused the installation.

For visual QA, add a Linux compositor screenshot adapter behind `qa-target` and
provide a visible test display for frame/animation measurements on the Mac.
Current `qa-shot` is macOS-specific, and the shipped MCP plugin lacks native Linux
capture. Background captures cannot prove that an occluded app is painting on time.

Codex desktop setup/actions can call the same repo recipes; the official
[local environments documentation](https://learn.chatgpt.com/docs/environments/local-environment)
describes that integration. Manual Git worktrees still need an explicit setup
entry point. Keep optional agent integrations thin and the portable commands authoritative.

## Verification of this first slice

- `just install`: passed in the new worktree; 13.2 seconds reported by pnpm.
- `just test-one scripts/agent-orient.test.mjs`: four initial tests failed before
  implementation; all five final integration tests pass, including a colliding
  linked worktree. Tests create their own temporary repositories and preserve
  checkout/index contents while exercising the public CLI.
- `just check`: passed on Linux with these changes; 1,839 unit tests and 381 editor
  tests passed, with nine pre-existing unit skips. Conformance, architecture gates,
  lint, formatting, Svelte/type checks and build completed. Existing lint/dead-code
  warnings remain. Full local output is saved in
  `test-results/agent-verification-20260906/check.log` (gitignored). This is not a
  full Rust workspace or device QA run.
- `just check-agent-docs`, `just check-qa-input-safety`, `just check-drift` and
  `git diff --check`: passed.
- Live orientation ran on Linux and on the Mac using copies of the new script and
  its existing slot dependency in a temporary scratch directory. The Mac command
  inspected the checkout read-only; it did not build, install or drive an app.

For subsequent tooling work, measure time to first relevant test, time from failure
to reproduction, invalid runs, and user interventions needed to obtain evidence.
Compare a small set of similar tasks before and after each improvement. A growing
list of commands is not itself evidence that agent work became easier.
