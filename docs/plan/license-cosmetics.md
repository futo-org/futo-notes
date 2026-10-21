# Plan: what a license includes — app icons, the landing after paying, attribution, and a license that follows the vault

Status: rough spec, 2026-10-15, reviewed by @justin the same day (decisions D11–D13 below
are his). **Updated 2026-10-19:** the cosmetics milestones (M1–M5) are the live work, W1 on iOS
(MR !426) and W2 on Android; in-app purchase and its server half (D15–D32, § 7b M7, § 7c M8)
are deferred, kept below as the record. Decided with @justin and FUTO's CEO: a
license may include **purely cosmetic** choices. Every working feature stays available
without one; what a license buys is the things that cost FUTO recurring money (sync) and the
cosmetics FUTO chooses to include. App icons are the first; themes are the likely second.
Behavioral truth to update: `docs/spec/license.md`, `docs/spec/settings.md`.
Sketches: `docs/plan/license-cosmetics/*.png` (exported from the reviewed design doc,
<https://claude.ai/code/artifact/e6bb4266-b1e4-42a8-b8ff-12e38cd1b417>; the doc stays the
editable original, the PNGs are what this plan was written against).

Written for an implementing agent. Read root `AGENTS.md`, `crates/futo-notes-license/AGENTS.md`,
`crates/futo-notes-ffi/AGENTS.md`, `apps/ios/AGENTS.md`, `apps/android/AGENTS.md`,
`crates/futo-notes-sync/AGENTS.md` (M6 only) and `docs/spec/AGENTS.md` before touching their
layers. Every milestone ends with its verification and a commit in `type(scope): imperative
summary` form with a `Verified:` line.

- [0. Decisions (locked — do not reopen without @justin)](license-cosmetics/0-decisions.md)
- [1. The picker when the license does not include icons (M2, M3)](license-cosmetics/1-picker-without-icons.md)
- [2. M1 — the Rust rule and its projections](license-cosmetics/2-m1-rust-rule.md)
- [3. M2 iOS, M3 Android — the picker](license-cosmetics/3-m2-m3-picker.md)
- [4. M4 — attribution on the Buy URL](license-cosmetics/4-m4-buy-url-attribution.md)
- [5. M5 — land on the reward after activation](license-cosmetics/5-m5-land-on-the-reward.md)
- [6. Catalog entries](license-cosmetics/6-catalog-entries.md)
- [7. M6 — the license follows the vault (DEFERRED by D28; ask-first; own MR)](license-cosmetics/7-m6-license-follows-the-vault.md)
- [7b. M7 — Buy everywhere: website where allowed, store purchase where not (does not wait for M6, D28; own MRs)](license-cosmetics/7b-m7-buy-everywhere.md)
- [7c. M8 — store purchases are redeemed for a FUTOpay key (ADOPTED, D29; lib-polar MR + client)](license-cosmetics/7c-m8-store-purchases-redeemed.md)
- [8. Order and sizing](license-cosmetics/8-order-and-sizing.md)
- [9. Open questions for @justin](license-cosmetics/9-open-questions.md)
- [10. Sketches](license-cosmetics/10-sketches.md)
