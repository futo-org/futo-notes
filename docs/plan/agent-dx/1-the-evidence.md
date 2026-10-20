## 1. The evidence

| Measure                                              | jfedora                                                                                                                  | MacBook                                           | Source                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------- |
| Sessions / user turns / assistant messages           | 113 / 575 / 17,538                                                                                                       | 67 / 276 / 11,345                                 | `~/.claude/projects/*futo-notes*`             |
| Bash calls / error rate                              | 7,643 / 2.2%                                                                                                             | 4,477 / 2.1%                                      | same                                          |
| `just check` runs                                    | 157                                                                                                                      | 83                                                | same; warm run ≈ 45 s, cold worktree 2 m 02 s |
| Time waiting on the human (plan approval, pickers)   | 49 min (one `ExitPlanMode`)                                                                                              | 85 min (9 `AskUserQuestion`)                      | same                                          |
| Hand-rolled polling loops among the 40 slowest calls | 15                                                                                                                       | 6                                                 | same                                          |
| `sleep` calls blocked by the harness                 | 17 of 54                                                                                                                 | 9 of 25                                           | same (`Blocked: sleep N followed by …`)       |
| Subagents spawned                                    | 177 (86 general, 60 app-qa, 23 fixer)                                                                                    | 158 (53 general, 45 app-qa, 35 fixer, 18 Explore) | same                                          |
| Worktrees / cargo `target/` dirs                     | 123 / 86                                                                                                                 | 33 / 12+                                          | `git worktree list`, `du`                     |
| Worktrees merged into main but still present         | 7                                                                                                                        | not measured                                      | `git merge-base --is-ancestor`                |
| Worktrees with uncommitted changes                   | 32                                                                                                                       | not measured                                      | `git status --porcelain`                      |
| Largest `target/` dirs                               | 145, 139, 139, 139, 132 GB                                                                                               | 97, 89, 80 GB, seven × 30 GB                      | `du -sh`                                      |
| Disk                                                 | 1.4 TB of 1.9 TB used                                                                                                    | 289 GiB of 926 GiB free                           | `df`                                          |
| Papercuts open / major / resolved                    | 135 / 8 / 64                                                                                                             | (shared log)                                      | `.papercuts.jsonl`                            |
| Main pipeline wall time (last 8 green)               | 9–32 min, median ≈ 15 min                                                                                                |                                                   | GitLab API                                    |
| Longest CI jobs                                      | `test:ios-native` 10 m, `test:cross-platform-sync:android` 8 m, `build:ios-native` 7.5 m, `test:desktop-smoke:macos` 7 m |                                                   | GitLab API                                    |
| Last 60 pipelines, any ref                           | 21 success / 30 failed / 9 canceled                                                                                      |                                                   | GitLab API                                    |

Two caveats on the numbers. Session wall-clock sums (601 h here, 453 h on the Mac) overlap because
sessions run in parallel, so they are not hours spent. `du` on btrfs counts reflinked `target/`
clones at full size, so the per-directory sizes are real but the total is not additive; the
authoritative figure is `df`.

What the transcripts show agents doing when nothing is wrong: a session opens with `git worktree
add` + `pnpm install` (1 s here, thanks to the shared store), runs `just check` (2 m 02 s cold on 32
cores, including the first cargo build of `futo-notes-model` and `futo-notes-tauri` tests), and
then spends most of its time in the real app or waiting. The setup phase is already cheap on this
machine. The expensive phases are the ones after it.
