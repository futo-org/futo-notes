## 7. Traps specific to this work

- Never OS-level input for desktop QA (M24); resolve the target with `scripts/qa-target.mjs` and drive the webview bridge. Never pattern-kill (M25).
- No screen-coordinate click injection, no UI scripting, no name-pattern process kills — the QA input-safety gate enumerates them so this doc does not have to. Claim devices with `just qa-claim`; release with `just qa-release`.
- The staging-signed native fixtures only verify on `.dev` builds. A release build shows Unlicensed for everything until Phase 8; that is correct (M3).
- Do not "tidy" `CHECKOUT_PRODUCT_SLUG` into `PRODUCT_SLUG` or vice versa (config.rs explains why).
- Do not add any licensed-only behavior beyond what `docs/spec/license.md` § What a license includes lists (ADR-0006; at the time of this plan, the card, the coin and the label were the whole reward).
- Do not bump `BRIDGE_VERSION`, touch the sync payload or `AppState` for this work; none of it is needed.
- `git stash` is shared across worktrees; use WIP commits.
- Regenerate UniFFI bindings after the `LicenseView` change before any native build (M9); `just *-native` does it, direct Xcode/Gradle does not.
