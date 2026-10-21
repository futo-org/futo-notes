# License program — master plan (living document)

Status: written 2026-10-16 for the agent overseeing the implementation across repos; **re-slated
2026-10-19** after @justin dropped in-app purchase for now. Owner of decisions: @justin. This file
is the **one place that says what is on the slate, in what order, and what is done**. It does not
restate designs; it points at them. Update the status table and append to § 9 as work lands.
Decisions are locked in the documents they live in; do not reopen one without @justin.

Read first, in this order:

1. [`docs/plan/license-cosmetics.md`](license-cosmetics.md): decisions D1-D14 (§ 0; D15-D32 are
   deferred), the cosmetics milestones M1-M5 (§ 1-6), M6 (§ 7, deferred), the store client M7
   (§ 7b, deferred), the server M8 (§ 7c, deferred), order and sizing (§ 8).
2. ADRs, newest last: [0004](../adr/0004-license-reuse-is-never-rejected.md) (a key is a bearer
   string), [0005](../adr/0005-license-purchase-follows-store-rules.md) (follow store rules),
   [0006](../adr/0006-a-license-may-include-cosmetics.md) (a license may include cosmetics),
   [0007](../adr/0007-ios-sells-the-license-in-app.md) and
   [0008](../adr/0008-store-purchases-are-redeemed-for-a-key.md) (in-app purchase and redemption;
   both **deferred 2026-10-19**, read as the record of the reasoning, not as the posture).
3. [`docs/spec/license.md`](../spec/license.md): behavioral truth. Its Gaps are the checklist of
   what is specified but not built; § 8 below maps each open Gap to the workstream that closes it.
4. Root `AGENTS.md`, then the `AGENTS.md` of every layer a workstream touches, before editing it.

Older plans, absorbed: the ship plan (shipped, since deleted; last version at commit 0774e8a2e; its
execution log is history), [`license-store-compliance.md`](license-store-compliance.md) (M1-M5 shipped 2026-09-24;
its M6 "real purchase on each shape" and M7 "store submission" are not scheduled; the posture it
shipped, ADR-0005, is still the one in force).

## 1. The one-paragraph picture

A license is a FUTOpay key + activation, verified offline in Rust on every platform
(`crates/futo-notes-license`). Since ADR-0006 a license includes choosing the app icon. **There is
no in-app purchase.** Where store rules allow a link, Buy opens the FUTOpay website: desktop, the
iOS US storefront and Android `direct`. iOS on other storefronts and Android `play` stay key-only
(ADR-0005); how far their copy may steer a buyer to the website is being researched, so the
key-only wording is under review and not touched by this program. License sync (M6) is deferred
(D28). Nothing on the slate touches `futo-notes-server` or lib-polar.

## 2. Repositories and who does what

| Repo | Local path | Remote | What changes |
|---|---|---|---|
| futo-notes (this) | `~/Developer/futo-notes/futo-notes` (+ worktrees beside it) | `gitlab.futo.org/futo-notes/futo-notes` | cosmetics (M1-M5), spec/ADR/plan, release notes |
| lib-polar (FUTOpay) | `~/Developer/lib-polar` | `gitlab.futo.org/futocore/library/lib-polar` | **nothing** for now; lib-polar!62 (the redeem endpoints) is the deferred path |
| futo-notes-server | `~/Developer/futo-notes/futo-notes-server` | — | **nothing**; M6 (deferred) would also need nothing there |
| App Store Connect, Google Play Console | — | — | nothing new; the store-setup checklist (M7.5) is deferred with the purchase work |

Every change goes through a merge request; nothing is committed to `main` directly, docs
included. The overseer runs the lanes, reviews, QA and merges; @justin does any store-console
work, a stable tag's go-ahead, and any decision marked his.

## 3. Workstreams, order, gates

Status legend: `done` · `in MR` (on a branch, not merged) · `in progress` · `next` · `deferred`.

| # | Workstream | Repo | Design | Size | Depends on | Status (2026-10-19) |
|---|---|---|---|---|---|---|
| W1 | Cosmetics on iOS + Rust + desktop projection: M1, M2 (iOS), M4, M5 (iOS) | futo-notes | cosmetics § 2-5 | done on branch | — | **in MR** !426 (`feat/license-cosmetics-ios`); needs iOS UI-test coverage and the desktop and Android checks, then merge |
| W2 | Cosmetics on Android: M3 (picker, sheet, row hint) and the M5 landing, to iOS parity | futo-notes | cosmetics § 1, 3, 5; sketch `05-android-and-second-device.png` | M | W1 (stacked on !426) | **in progress**; own MR stacked on !426 |
| W3 | M8 lib-polar redemption endpoints | lib-polar | cosmetics § 7c | M | — | **deferred** 2026-10-19: only needed to redeem a store purchase, which is not being built. lib-polar!62 implements it |
| W4 | M7.1 Rust redeem + routing | futo-notes | cosmetics § 7b M7.1 | S-M | W3 | **deferred**: nothing to redeem. Draft MR !427 (`feat/license-store-redeem`) implements it |
| W5 | M7.5 store setup (human) | consoles | cosmetics § 7b M7.5 | days | — | **deferred**: the products and testers exist only for purchases |
| W6 | M7.2 StoreKit + M7.3 Play Billing + M7.4 copy | futo-notes | cosmetics § 7b M7.2-M7.4 | M + M + S | W4 | **deferred**: no in-app purchase for now; the key-only copy stays as shipped |
| W7 | QA + release | futo-notes | § 6 below | — | W1, W2 merged | **next after W2**; release notes in `release-notes/`; a stable tag needs @justin's OK |
| W8 | M6 license follows the vault (one proof kind) | futo-notes | cosmetics § 7 | L, `/slow-review` | @justin OK to start | **deferred** (D28) |
| W9 | Android `play` names the website: plain-text `pay.futo.org`, no link, no price; Rust's yes/no `license_link_out` becomes a three-way purchase surface (link out, name the website, key only) | futo-notes | research `license-ios-app-store/research-2026-10-19.md` § Android `play` | S-M | W2 | **next after W2** (same agent). FUTO Notes is unhidden on the pay storefront by manifest-inventory !5 (not merged) |
| W10 | iOS App Store-only purchase: a StoreKit non-consumable that includes what a license includes, no key, no server | futo-notes | [`license-ios-app-store.md`](license-ios-app-store.md), [ADR-0009](../adr/0009-ios-sells-an-app-store-only-purchase.md) | M | W9 (rebase), App Store Connect setup for real purchases | **implemented 2026-10-19** on `feat/license-ios-appstore` (rebased on W9): Rust evidence rule, StoreKit shell, simulator-verified; TestFlight purchase pending |

MRs !427 (`feat/license-store-redeem`) and lib-polar!62 implemented the deferred path and were
closed 2026-10-19; their branches remain on the remotes.

Critical path: W1 QA and merge, W2, W9, W10, W7. W10 is required before any stable tag that ships
the iOS icon gate: without an in-app purchase, a key that enables anything in the app breaks App
Review 3.1.1 (ADR-0009). Nothing waits on lib-polar.

## 4. Per-workstream notes (what the fresh agent needs beyond the pointers)

**W1, land the iOS cosmetics MR.** The branch holds the Rust rule + FFI + Tauri view, the iOS
picker/sheet/row hint/landing, `from=` on the Buy URL, copy, and all the docs. Before merge it
needs iOS UI-test coverage (native, simulator), a desktop check (the Tauri view carries `includes`;
desktop renders nothing new, so the check is "nothing regressed" on the License card) and an
Android compile + unit run plus an Android check (Android is untouched in behavior but must still
build and pass). The MR is !426
(<https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/426>). A `/mr-qa` SHIP verdict
means merge. The key-only copy variants in the iOS build (`footnoteKeyOnly`,
`keyOnlyExplanation`) are correct for the posture in force (ADR-0005) and stay; their wording is
under review separately, so do not change it here.

**W2, Android cosmetics.** Its own MR, stacked on !426 (W1 is already large and the plan's own time
box says so). Scope is exactly cosmetics § 3 (Android bullets) and § 5 (Android
`LicenseLinkActivity` → `MainActivity` landing, `AppIconSystemTest`), to iOS parity. Existing
files: `apps/android/app/src/main/java/com/futo/notes/ui/settings/appicon/` (sheet + controller),
`ui/SettingsScreen.kt` (row hint), tests under `androidTest/.../settings/appicon/`. Closes the two
Android Gaps in license.md (§ What a license includes; § Deep link landing). Drive on a pooled
emulator (or jfedora) per `apps/android/AGENTS.md` and the QA memory rules.

**W3-W6, deferred.** In-app purchase and redemption: designs in cosmetics § 7b and § 7c, decisions
in ADR-0007 and ADR-0008, all kept as the record. Reason: @justin dropped in-app purchase on
2026-10-19; it needs a lib-polar change and a store-submission cycle that are not wanted now.
Picking them up again is a new decision, and the first step is re-reading Apple 3.1.1 /
3.1.1(a) / 3.1.3(b) and the Play Payments policy, because the snapshots in ADR-0005 and ADR-0007
age quickly.

**W7, QA and release.** See § 6.

**W8, M6.** Deferred. When @justin says go: cosmetics § 7 (carrier = the hidden engine slot, one
proof kind, Remove tombstone wins over an offline device), own MR, `/slow-review`, cross-platform
sync harness. Nothing in W1-W7 should make it harder; keep license storage shaped as "one pair".

## 5. Explicitly not on the slate

- Play Billing, and server redemption of any store purchase: deferred 2026-10-19 (ADR-0007,
  ADR-0008), not canceled. The one in-app purchase on the slate is W10's App Store-only
  purchase on iOS (ADR-0009), which never becomes a key.
- Any change to lib-polar.
- Refund / revocation handling of any kind (D18). `revocationDate` and voided purchases are ignored.
- Share-by-hand of a store proof (deep link / QR / file): considered 2026-10-16 and dropped in
  favor of D29; a redeemed key is shared the way any key is.
- Google Play Developer API (service account), server-side acknowledgment, Apple App Store Server
  API keys: not needed for v1 (§ 7c.5 option (b) is the upgrade path).
- A second Play app for staging (D27), a Mac App Store or Microsoft Store build, a web client Buy.
- Any change to `futo-notes-server`.

## 6. Release gates (W7)

In order; each is a line to tick in § 9 with evidence.

1. W1, W2, W9 and W10 merged to `main`; `just check`, Rust, iOS and Android suites green on `main`.
2. Real-device passes recorded: the iOS picker and landing (`docs/qa/license-store-ios.md` holds
   the iOS story record; extend it for Android), the Android picker and landing, and the desktop
   License card unchanged.
3. `release-notes/v<X.Y.Z>.md` written in the release MR, on the tagged commit (format and limits:
   `release-notes/README.md`; verify with `just release-notes-check`). Copy for the store listing
   may say a license can be bought (iOS sells one in the app, W10) but never names the website or a price: the App Store text is metadata shared across storefronts (3.1.1(a)).
4. A stable tag publishes to Play production and Apple review, so it needs @justin's OK. Use
   `/release`.

## 7. Operating rules for the overseer

- All work through MRs; `/mr-qa` before merge; a fix pushed mid-QA voids SHIP and is re-driven.
- Platform coverage is never descoped for cost; only host incapability is a reason to skip a
  platform, and it is written down.
- iOS builds go to the simulator, not the physical phone, unless told otherwise; Android and
  Linux-heavy work prefers jfedora. Never steal focus or use OS-level keystrokes on this Mac.
- Keep the main thread lean: delegate CI watching, QA legs, fixes and landing loops to subagents
  with short summaries; cap fan-outs at about six live agents.
- Update this file's status table and § 9 when a workstream changes state; update
  `docs/spec/license.md` Gaps (via `/spec-sync`) when behavior lands; do not restate designs here.
- Decisions belong to @justin. If a workstream needs one, write the question and a recommendation
  into cosmetics § 9 and continue with everything that does not depend on it.

## 8. Open spec Gaps → closing workstream

From `docs/spec/license.md` on 2026-10-19:

| Gap | Closed by |
|---|---|
| Android and desktop do not render what a license includes | W2 (Android); desktop needs no UI, close the desktop half with W1's merge |
| Android landing not implemented | W2 |
| License sync (per-device license) | W8 (deferred); stays open |
| Buy URL `platform` / `from` not recorded server-side | lib-polar owner; not part of this program now, stays open |
| No in-Play purchase path | stays open by decision (in-app purchase deferred 2026-10-19) |
| No in-app restore by e-mail | stays open (support path) |
| No revocation check | stays open by decision (D18) |
| Fourth card state (not yet read) unspecified | unchanged by this program; leave as is |
| Key field has no stated input contract / `futonotes` scheme declared once on macOS | unchanged by this program; leave as is |

The "target store posture" Gap is gone: it described the deferred design, so the spec now records
in-app purchase as deferred in its Store posture section instead (2026-10-19).

## 9. Log (living, append only)

- 2026-10-16 — Program defined. D29 (redeem for a key, ADR-0008) and D30-D32 recorded; W1 is
  on `feat/license-cosmetics-ios` as MR !426, nothing else started. lib-polar `main` at `1d6c4f2`.
- 2026-10-19 — Change of plan (@justin): **no in-app purchase** and **no lib-polar change**. The
  store-purchase work is deferred, not canceled: ADR-0007 and ADR-0008 are marked Deferred,
  cosmetics D15-D32, § 7b (M7) and § 7c (M8) are marked deferred, and W3-W6 and W8 are deferred.
  License sync (M6) stays deferred. Buy stays as shipped: the FUTOpay website where a link is
  allowed (desktop, iOS US, Android `direct`); iOS elsewhere and Android `play` stay key-only, and
  the key-only wording is under review by a separate research task (not edited here). Active: W1
  (MR !426), W2 (Android parity, own MR stacked on !426), then QA and a release (W7, which needs
  @justin's OK for the stable tag). Draft MR !427 (`feat/license-store-redeem`) and lib-polar!62
  implement the deferred path; they are to be closed or parked, decision pending with @justin. The
  spec's "target store posture" Gap was removed.
- 2026-10-19 (later) — @justin: !427 and lib-polar!62 **closed**. Steering research (now in
  `license-ios-app-store/research-2026-10-19.md`) found Android `play` may name the website in
  plain text everywhere (Google's consumption-only rule) → W9, using `pay.futo.org`; manifest-inventory
  !5 unhides the product there. It also found that on iOS a key enabling the icon picker breaks
  3.1.1 in every storefront; @justin chose a low-key App Store-only purchase with no key
  (ADR-0009) → W10, planned in `license-ios-app-store.md` for an agent on a Mac.
