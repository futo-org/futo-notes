## 1. State of the branch on 2026-09-16 (read before starting)

- 23 commits ahead of `origin/main`, **3 behind**. Merge main first (Phase 1).
- **CI is red on every job** (pipeline 36505): `pnpm install --frozen-lockfile` fails because `pnpm-lock.yaml` lists `@types/three` under `dependencies` while `package.json` has it under `devDependencies`. Running `pnpm install` produces a 6-line lockfile fix; it is sitting **uncommitted** in the `.claude/worktrees/license` worktree.
- `just check` has never been run on the WIP commit `08a31503`. The coin has never been seen in the real desktop app.
- Production FUTOpay has **no `futo-notes` org** (`GET https://pay2.futo.org/checkout/polar/futo-notes/activation/public-key` → "Public key not found"; `/futo-notes-license/info` → "Organization not found"). `PRODUCTION_PUBLIC_KEY_BASE64` in `crates/futo-notes-license/src/config.rs` is a fail-closed placeholder. **Nothing in this repo can ship to real users until Phase 6.**
- Staging is complete: org, product, key baked, a real purchase delivered a key and activated iOS and Android on 2026-09-15 (spec § Gaps).
- Production mints **v1** activations (no `issued_at`, no `expires_at`). Expired and Renew are built and tested but unreachable in production because the product is perpetual.
- MR !303's description is stale (it says the branch is blocked on license delivery). Issues #160 and #161 are open though their work is done.
