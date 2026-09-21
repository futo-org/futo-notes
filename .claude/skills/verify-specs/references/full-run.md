# Full-run topology and sizing

**Default full-run topology — 4 worktrees, 10 legs (9 platform + 1 mesh):**

| Worktree | Devices claimed | Legs (concurrent, distinct devices) |
|---|---|---|
| extra-A | iOS + Android + desktop | group-A on iOS, Android, desktop |
| extra-B | iOS + Android + desktop | group-B on iOS, Android, desktop |
| extra-C | iOS + Android + desktop | group-C on iOS, Android, desktop |
| main | iOS + Android + desktop + `qa-server` | sync mesh (all clients → one server) |

Surface groups: **A** = `editor` + `app`; **B** = `list` +
`nav` + `tabs`; **C** = `search` + `settings` + `settings-visual` + `sync`
(single-client).

The editor dedup (SKILL.md Step 2) shapes group A: the **desktop** A-leg
sweeps the full `editor` surface; the iOS/Android A-legs carry a `focus`
limited to the shell-integration delta plus platform-tagged editor stories.

## RAM caps — a PROVISIONING decision, not the workflow's job

Per-platform concurrency equals how many devices you claim: claim 3 Android
emulators → only 3 legs ever drive Android at once, regardless of the workflow
scheduler. On ≤32GB keep **Android ≤3 concurrent** (mr-qa's measured ceiling)
and iOS ≤4. Downshift when the machine is small:

- **Fewer worktrees**: 3 worktrees + mesh-as-a-second-wave (run the Workflow a
  second time with only the mesh leg after the platform legs free their
  devices) keeps Android at 3.
- **Scoped runs** usually need only 1–2 worktrees — provision to the scope.

## Execution constraints

Use `.claude/skills/verify/references/session.md` for setup, identity, evidence,
and teardown. Pre-build before spawning legs. On a 32 GB host, cap Android at two
emulators while building and three at steady state; serialize expensive iOS builds.
The mesh can run concurrently only with its own claimed devices; otherwise use a
second wave. Quota-limited waves resume from commit-bound ledgers.

QA legs report only. If fixes are requested, assign disjoint code scopes; runtime
fixes need their own claimed device so the fixer can exercise the mechanism.
Independent platform verifiers rerun the exact repros, followed by `just check`.
