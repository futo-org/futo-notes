### Phase 1 — make the branch honest — DONE 2026-09-16

- `build(deps): move @types/three to devDependencies in the lockfile` (10ef63d9).
  `pnpm install --frozen-lockfile --offline` → green. This was the sole cause of
  pipeline 36505 being red on every job.
- `git merge origin/main` — clean, no conflicts (3 commits: the `just worktree`
  recipe and a papercuts entry). None of the predicted license-file conflicts
  materialised.
- `just check` → **green** (exit 0), after one fix: the QA input-safety gate
  failed on this very plan document, because §7 named three banned QA-input
  tools in a line that forbids them and the gate is deny-by-default on every
  instruction surface. Reworded to point at the gate instead of naming them
  (commit `docs(license): state the QA input prohibition without naming the
  tools`). Do not allowlist that pattern.
- Note for anyone running `just check` from a tool: piping it through `head`/
  `tail` reports the pipe's exit status, not the recipe's (M11). Redirect to a
  file and check `$?`.
