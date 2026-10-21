## 7. Proposed first MR set

1. `just wt new` / `just wt gc` + Linux reflink (P1.1, P1.6's `CARGO_TARGET_DIR` fix).
2. `agent-orient.mjs` + the three hooks (P1.2, P1.3).
3. `ci-wait` / `mr-status` (P1.4).
4. Papercut sweep of the 8 majors, scheduled gardener (P1.5).

Each lands with a red proof for what it guards, updates the recipe list in `justfile`, and adds
nothing to the root `AGENTS.md` except a pointer.
