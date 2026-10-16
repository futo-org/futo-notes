# License program — master plan (living document)

Status: written 2026-10-16 for the agent overseeing the implementation across repos. Owner of
decisions: @justin. This file is the **one place that says what is on the slate, in what order,
and what is done**. It does not restate designs; it points at them. Update the status table and
append to § 9 as work lands. Decisions are locked in the documents they live in; do not reopen one
without @justin.

Read first, in this order:

1. [`docs/plan/license-cosmetics.md`](license-cosmetics.md): decisions D1-D32 (§ 0), the
   cosmetics milestones M1-M5 (§ 1-6), M6 (§ 7, deferred), the store client M7 (§ 7b), the server
   M8 (§ 7c), order and sizing (§ 8).
2. ADRs, newest last: [0004](../adr/0004-license-reuse-is-never-rejected.md) (a key is a bearer
   string), [0005](../adr/0005-license-purchase-follows-store-rules.md) (follow store rules),
   [0006](../adr/0006-a-license-may-include-cosmetics.md) (a license may include cosmetics),
   [0007](../adr/0007-ios-sells-the-license-in-app.md) (Buy everywhere; routing),
   [0008](../adr/0008-store-purchases-are-redeemed-for-a-key.md) (a store purchase becomes a key).
3. [`docs/spec/license.md`](../spec/license.md): behavioral truth. Its Gaps are the checklist of
   what is specified but not built; § 8 below maps each open Gap to the workstream that closes it.
4. Root `AGENTS.md`, then the `AGENTS.md` of every layer a workstream touches, before editing it.

Older plans, absorbed: [`license-ship.md`](license-ship.md) (shipped; its execution log is
history), [`license-store-compliance.md`](license-store-compliance.md) (M1-M5 shipped 2026-09-24;
its M6 "real purchase on each shape" and M7 "store submission" are replaced by W6 below, under the
2026-10-16 posture).

## 1. The one-paragraph picture

A license is a FUTOpay key + activation, verified offline in Rust on every platform
(`crates/futo-notes-license`). Since ADR-0006 a license includes choosing the app icon. Every
device gets a working Buy (ADR-0007): the website where a link is allowed (iOS US, Android
`direct`, desktop), the store's own in-app purchase where it is not (iOS elsewhere, Android
`play`). A store purchase is **redeemed on FUTOpay for an ordinary key** (ADR-0008, D29): one
user-initiated POST, the server verifies the store's proof and mints through the existing key path,
the client holds only FUTOpay pairs. Until redemption succeeds nothing is granted. Refunds are out
of scope (D18). License sync (M6) is deferred (D28). Nothing on the slate touches
`futo-notes-server`.

## 2. Repositories and who does what

| Repo | Local path | Remote | What changes |
|---|---|---|---|
| futo-notes (this) | `~/Developer/futo-notes/futo-notes` (+ worktrees beside it) | `gitlab.futo.org/futo-notes/futo-notes` | cosmetics (M1-M5), Rust redeem + routing (M7.1), iOS and Android store shells (M7.2-M7.4), spec/ADR/plan |
| lib-polar (FUTOpay) | `~/Developer/lib-polar` | `gitlab.futo.org/futocore/library/lib-polar` | M8: `POST /api/v1/redeem/{apple,google}/{org}`, tables, tests, config; deploy `staging-pay2.futo.org` then `pay2.futo.org` |
| futo-notes-server | `~/Developer/futo-notes/futo-notes-server` | — | **nothing**; M6 (deferred) would also need nothing there |
| App Store Connect, Google Play Console | — | — | M7.5 human checklist, @justin only |

Every change goes through a merge request; nothing is committed to `main` directly, docs
included. The overseer runs the lanes, reviews, QA and merges; @justin does the store consoles,
the production deploys' go-ahead, and any decision marked his.

## 3. Workstreams, order, gates

Status legend: `done` · `in MR` (on a branch, not merged) · `next` · `blocked on X` · `deferred`.

| # | Workstream | Repo | Design | Size | Depends on | Status (2026-10-16) |
|---|---|---|---|---|---|---|
| W1 | Cosmetics on iOS + Rust + desktop projection: M1, M2 (iOS), M4, M5 (iOS) | futo-notes | cosmetics § 2-5 | done on branch | — | **in MR**: branch `feat/license-cosmetics-ios` (this plan's branch); needs `/mr-qa` on iOS + desktop, then merge |
| W2 | Cosmetics on Android: M3 (picker, sheet, row hint) and the M5 landing | futo-notes | cosmetics § 1, 3, 5; sketch `05-android-and-second-device.png` | M | W1 merged (or rebased onto it) | **next**; own MR (recommended, see § 4) |
| W3 | M8 lib-polar: Apple + Google redemption, one MR (D32); staging then production | lib-polar | cosmetics § 7c.1-7c.2 (Apple, L1-L6), § 7c.5 (Google, L7-L10), ADR-0008 | M | nothing in this repo; needs the App Store numeric app id and the Play public key from W5 for its config | **next, start now**: it is the long pole and gates W6 |
| W4 | M7.1 Rust: `redeem_store_purchase`, `post_json` transport, FFI exports, `license_buy_route`, conformance | futo-notes | cosmetics § 7b M7.1, § 7c.3 (A1) | S-M | W1 merged (shares `contract.rs`) | **next**, parallel with W3 |
| W5 | M7.5 store setup (human) | consoles | cosmetics § 7b M7.5 | days of calendar time | — | **start now** (@justin); feeds W3's config |
| W6 | M7.2 iOS StoreKit + M7.3 Android Play Billing + M7.4 copy, pending state, Restore | futo-notes | cosmetics § 7b M7.2-M7.4, § 7c.3 (A2-A6) | M + M + S | W4; real-purchase QA needs W3 on staging and W5's products | blocked on W4 |
| W7 | End-to-end QA, production deploy, store submission | all | § 6 below; cosmetics § 7b M7.6 tests, M7.5 step 6 | — | W3 on production, W6 merged, W2 merged (Play ships icons gated too) | blocked |
| W8 | M6 license follows the vault (one proof kind) | futo-notes | cosmetics § 7 | L, `/slow-review` | @justin OK to start | **deferred** (D28) |

Critical path: **W3 and W5 start today**; W1 QA + merge; W4; W6; W7. W2 runs beside W4/W6 and must
be merged before W7's Play submission.

## 4. Per-workstream notes (what the fresh agent needs beyond the pointers)

**W1, land the iOS cosmetics MR.** The branch holds 24 commits (Rust rule + FFI + Tauri view,
iOS picker/sheet/row hint/landing, `from=` on the Buy URL, copy, all the docs). Run `/mr-qa` on
it: iOS (native, simulator) and desktop (the Tauri view carries `includes`; desktop renders
nothing new, so the check is "nothing regressed" on the License card). Android is untouched in
behavior but compiles; include an Android compile + unit run. Open the MR against `main` if it
does not exist (title: "License cosmetics: app icons come with a license (iOS)"). SHIP means merge.
The key-only copy variants currently in the iOS build (`footnoteKeyOnly`, `keyOnlyExplanation`)
are correct for today's shipped posture (ADR-0005) and retire in W6 (M7.4); do not remove them in W1.

**W2, Android cosmetics.** Recommended as its own MR rather than growing W1 (W1 is already large
and the plan's own time box says so). Scope is exactly cosmetics § 3 (Android bullets) and § 5
(Android `LicenseLinkActivity` → `MainActivity` landing, `AppIconSystemTest`). Existing files:
`apps/android/app/src/main/java/com/futo/notes/ui/settings/appicon/` (sheet + controller),
`ui/SettingsScreen.kt` (row hint), tests under `androidTest/.../settings/appicon/`. Closes the two
Android Gaps in license.md (§ What a license includes; § Deep link landing). Drive on a pooled
emulator (or jfedora) per `apps/android/AGENTS.md` and the QA memory rules.

**W3, lib-polar.** One MR (D32). Follow § 7c.2 for Apple (library `app-store-server-library`,
all three Apple roots as DER in the repo, `enable_online_checks=False`, one verifier per
environment, never `XCODE`/`LOCAL_TESTING`, `apple_transactions` table keyed by
`originalTransactionId`) and § 7c.5 for Google (RSA PKCS1 v1.5 over `original_json` with the Play
public key, `google_purchases` table keyed by `purchaseToken`, `orderId` nullable). Both mint
through the existing `create_key_func` and are idempotent. Config is non-secret `.env` style
(`APPLE__*`, `GOOGLE__*`, product maps); the org signing key is the deployed one, not 1Password
(see the FUTOpay memory notes). Sandbox: accept on production, flag the row (D30 (a)); the v2
short-expiry containment waits for `feat/futo-notes-v2-activation`, which is **not** a
prerequisite. Tests need no Apple or Google: throwaway CA for Apple, minted RSA key for Google,
plus one real golden of each once W5 produces a sandbox / license-tester purchase. The first real
fixture of each kind confirms the library's exception and payload names and Google's hash. Deploy
staging first (every end-to-end test needs it), production before any submission, with
`APPLE__ACCEPT_SANDBOX` on. What fronts `pay2` (body-size cap, per-IP limit) is unknown: ask the
lib-polar owner, do not add rate limiting inside the app. The server reviewers are not this repo's;
budget calendar time.

**W4, Rust redeem.** § 7b M7.1 is the spec. Keep `evaluate` untouched; the pair that comes back
is verified exactly like a typed one, so a wrong server cannot license anything. Update
`crates/futo-notes-license/AGENTS.md`'s "exactly one GET" rule to "at most one request per
explicit user action" in the same MR, and the spec principle line with it. Routing
(`license_buy_route`, `BuyRoute`, `LicenseAction::Restore`) replaces `license_link_out` here too;
the shells keep compiling against the old shape until W6 by keeping a thin adapter, or W4 and W6
land as one MR if that is simpler. Conformance cases in `tests/conformance/license.json` are
shared by Swift, Kotlin and the Tauri shell: regenerate with `scripts/gen-license-fixture.mjs`.

**W5, store setup (@justin).** Cosmetics § 7b M7.5 is the checklist. Two outputs feed W3's
config: the app's **numeric Apple ID** and the **Play Base64 RSA public key** (they go into
lib-polar's staging and production `.env`, not into the client). Two outputs feed W7: a TestFlight
build path with sandbox testers, and an internal-testing track with license testers. Step 6 is the
hard gate: never submit before production FUTOpay carries W3 with Sandbox acceptance on.

**W6, the store shells.** § 7b M7.2 (iOS), M7.3 (Android `play` only; the `direct` flavor must
stay free of Play services, with the Gradle check), M7.4 (copy: pending state, Try again, Restore;
key-only strings retire; "unlocks" allowed everywhere). The pending slot holds the receipt
unevaluated; the transaction is finished / the purchase acknowledged only after the returned pair
verifies locally. No retry on open (D31). Debug builds and tests use a fake store and a fake
redeem; the real check is a Sandbox purchase on a TestFlight build with `FUTO_LICENSE_ENV=staging`
and a license-tester purchase on the internal track, both against staging FUTOpay. Use the
`platform coverage` rule: anything touching `apps/ios` or `apps/android` is driven on that platform.

**W7, QA, deploy, submit.** See § 6.

**W8, M6.** Deferred. When @justin says go: cosmetics § 7 (carrier = the hidden engine slot, one
proof kind, Remove tombstone wins over an offline device), own MR, `/slow-review`, cross-platform
sync harness. Nothing in W1-W7 should make it harder; keep license storage shaped as "one pair".

## 5. Explicitly not on the slate

- Refund / revocation handling of any kind (D18). `revocationDate` and voided purchases are ignored.
- Share-by-hand of a store proof (deep link / QR / file): considered 2026-10-16 and dropped in
  favor of D29; a redeemed key is shared the way any key is.
- Google Play Developer API (service account), server-side acknowledgement, Apple App Store Server
  API keys: not needed for v1 (§ 7c.5 option (b) is the upgrade path).
- A second Play app for staging (D27), a Mac App Store or Microsoft Store build, a web client Buy.
- Any change to `futo-notes-server`.

## 6. Release gates (W7)

In order; each is a line to tick in § 9 with evidence.

1. W1, W2, W4, W6 merged to `main`; `just check`, Rust, iOS and Android suites green on `main`.
2. W3 live on **staging** FUTOpay; a Sandbox purchase on a TestFlight build (`FUTO_LICENSE_ENV=staging`)
   and a license-tester purchase on the internal track each end Licensed with the normal key
   card; Restore after a reinstall returns the same key; the revealed key activates desktop and
   the other phone by paste. Recorded per `docs/qa/license-store-ios.md` (extend it for Android).
3. Pending-state drill: block the redeem host, buy, see the pending card, unblock, Try again,
   Licensed; on Android confirm the purchase was not acknowledged while pending.
4. W3 live on **production** FUTOpay with Sandbox acceptance on; one Sandbox purchase on a
   TestFlight build against production ends Licensed (this is what App Review will do).
5. Store listings: no mention of buying, pricing or the website (listing text is per locale, not
   per storefront). Review notes per cosmetics § 7b M7.5 step 5, plus ADR-0008's line that the
   purchase is activated by a FUTO server call. Privacy copy and the Play Data safety form say a
   purchase receipt is sent to FUTO to issue the license.
6. Re-read Apple 3.1.1 / 3.1.1(a) / 3.1.3(b) and Play Payments policy § 4 on submission day;
   update ADR-0007's rules snapshot if anything moved.
7. Submit iOS and the Play `play` AAB; `/release` for the desktop/direct builds as usual.

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

From `docs/spec/license.md` on 2026-10-16:

| Gap | Closed by |
|---|---|
| Android and desktop do not render what a license includes | W2 (Android); desktop needs no UI, close the desktop half with W1's merge |
| Android landing not implemented | W2 |
| Target store posture not implemented (ADR-0007 + ADR-0008) | W4 + W6 + W7 |
| License sync (per-device license) | W8 (deferred); stays open |
| Buy URL `platform` / `from` not recorded server-side | lib-polar owner; may fold into W3 as a one-line metadata forward, else stays open |
| No in-Play purchase path | W6 (M7.3) |
| No in-app restore by e-mail | stays open (support path); Restore on the same store arrives with W6 |
| No revocation check | stays open by decision (D18) |
| Fourth card state (not yet read) unspecified | W6 specifies the pending state alongside it; the "not yet read" state itself stays as documented |
| Key field has no stated input contract / `futonotes` scheme declared once on macOS | unchanged by this program; leave as is |

## 9. Log (living, append only)

- 2026-10-16 — Program defined. D29 (redeem for a key, ADR-0008) and D30-D32 recorded; W1 is
  on `feat/license-cosmetics-ios`, nothing else started. lib-polar `main` at `1d6c4f2`.
