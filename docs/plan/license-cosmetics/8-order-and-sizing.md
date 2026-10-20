## 8. Order and sizing

Order since 2026-10-19: **W1, W2, release.** The names are the work items in
[`license-master-plan.md`](../license-master-plan.md).

| Milestone | Scope | MR | State |
|---|---|---|---|
| M1 | Rust rule + FFI/Tauri projection + spec/ADR rewrite + catalog | W1, MR !426 | in MR |
| M2 | iOS picker, sheet, row hint | W1, MR !426 | in MR |
| M4 | Buy URL `from` | W1, MR !426 | in MR |
| M5 (iOS) | Post-activation landing | W1, MR !426 | in MR |
| M3, M5 (Android) | Android picker, sheet, row hint, landing | W2, its own MR stacked on !426 | in progress |
| Release | Release notes in `release-notes/`, QA, stable tag (needs @justin's OK) | after W1 and W2 merge | not started |
| M6 | License follows the vault (one proof kind, hidden engine slot) | own MR | **deferred (D28)**. Size L (sync engine, `/slow-review`) |
| M7.1–M7.5 | Store purchases: Rust redeem and routing, StoreKit, Play Billing, copy, store setup | own MRs | **deferred 2026-10-19** (§ 7b). Draft MR !427 (`feat/license-store-redeem`) holds the Rust half |
| M8 | lib-polar redemption endpoints | other repo | **deferred 2026-10-19** (§ 7c). lib-polar!62 holds it |

Sizing: W1 is large already (the time box below applied to it); W2 is size M and is exactly the
Android bullets of § 3 and § 5. Neither depends on M6, M7 or M8.

Time box: M1-M5 is one merge request per platform. If W1 is not green in a week, ship M1-M3 and
move M4-M5 to a follow-up rather than growing the MR.
