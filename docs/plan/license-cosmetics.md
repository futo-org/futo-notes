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

## 0. Decisions (locked — do not reopen without @justin)

**D15–D32 are deferred (2026-10-19, @justin).** They describe selling the license through
StoreKit and Play Billing and redeeming the purchase on FUTOpay. That work is parked, not
cancelled: it needs a lib-polar change and a store-submission cycle that are not wanted now. They
stay here as the record of the reasoning and are **not** in force. In force instead: ADR-0010 and
ADR-0005's posture (Buy opens the FUTOpay website on desktop, iOS US storefront and Android
`direct`; iOS elsewhere and Android `play` stay key-only). The wording of the key-only surfaces
is under review separately; do not change it from this plan.

| # | Decision | Value |
|---|---|---|
| D1 | What a license includes today | **Choosing the app icon.** All six existing choices (Standard, Reversed, Dark, Dark Reversed, FUTO, Scanlines). Standard is the default every install has, not a "free" tier. No seventh, licensee-only icon. |
| D2 | The gate is on choosing, never on keeping | A removed or expired license leaves whatever icon is set. Nothing in the app ever changes the icon on its own except Full reset (unchanged: it restores Standard). |
| D3 | Expired | Expired does **not** include the icons: Expired is Unlicensed with a story. The picker shows the same ask, with "Renew" where Buy would be. |
| D4 | Where the ask may appear (the nag budget) | Only where the user walked in: the picker (coin badges, footnote, the sheet on tap) and the License card's one new sentence. Never on launch, never a popup, never in the editor or the list. |
| D5 | Vocabulary | (D17 would have allowed "unlock(s)" on every surface and retired the key-only variants; deferred 2026-10-19, so the rule below stands.) "included with a license", "comes with a license", and "unlock(s)" for what a license includes (cosmetics): allowed on **link-out builds only**, @justin 2026-10-16 (the footnote and sheet say "unlocks the ability to change the app icon"). Key-only builds (no Buy in `licenseRowActions`; App Store 3.1.1) keep "included with a license" (`settings.appIcon.license.footnoteKeyOnly`; their sheet is `license.keyOnlyExplanation`). **Never** "paywall", "premium". "free" and "donate" stay banned (license.md § Principles). |
| D6 | Store posture | **In force** (D17, which would have ended the key-only surfaces, is deferred 2026-10-19; the key-only wording is under review). Unchanged from ADR-0005. Key-only builds (iOS outside the US, Android `play`) get the key-only ask: `license.keyOnlyExplanation` + "I already paid", no Buy, no "Lost your key?", no website. |
| D7 | Desktop | No picker, so no visible change. Desktop still projects the Rust rule (M1) so a future desktop cosmetic is one shell change. The card's new sentence renders on native only. |
| D8 | Rust owns the rule | What a license includes is one Rust answer (`license_includes`), projected through UniFFI and Tauri. No Swift/Kotlin/TS copy. Shells only ask. |
| D9 | The spec principle changes | "Nothing is gated" becomes "Nothing that works is gated." Rewritten in the same MR as M1, with ADR-0006 recording the decision and the CEO's sign-off. |
| D10 | License sync (M6) is its own MR, after this plan is approved | It touches the sync payload (AGENTS.md §11.6). This document is the ask; M6 does not start until @justin OKs its section. **Amended by D16:** M6 is now required before the iOS IAP ships; it is still its own MR and still waits for that OK (open question 3). **Superseded in part by D28:** M6 is deferred, not required for the IAP. |
| D11 | Picker treatment | **Concept A**: coin badges on every tile but the current one, one footnote under the grid, a sheet on tap. Concept B (an ask card inside the picker) is rejected. (@justin 2026-10-15) |
| D12 | The License card does not change | No new sentence on the Unlicensed card. The App icon row hint is the only Settings-level touch. `license.explanationIncludes` is **not** added. (@justin 2026-10-15) |
| D13 | Picker once Licensed | The coin **stays** on every icon but Standard, so the picker still shows which ones came with the license. No footnote, no ask, no sheet. (@justin 2026-10-15) |
| D14 | The icon restriction applies to everyone | Every country, every platform. No per-country rule (D1 stands). (@justin 2026-10-16) |
| D15 (deferred 2026-10-19) | iOS sells the license as a non-consumable IAP; no server work (extended to both stores by D17) | Outside the US, steering is banned (ADR-0005) and a bare key field that unlocks a feature conflicts with guideline 3.1.1, so iOS adopts ADR-0005 option B at the license price, which puts the key field under 3.1.3(b). FUTOpay/lib-polar does not change; an IAP purchase is **not** converted into a FUTOpay key. A license has two proofs, the FUTOpay pair or an App Store signed transaction (JWS), and Rust `evaluate` accepts either (D8); the Apple proof is verified **offline in Rust** against a pinned Apple root. ADR-0007. (@justin 2026-10-16) **Superseded by D29:** the IAP stands; the proof is redeemed for a FUTOpay key on the server. |
| D16 (deferred 2026-10-19) | M6 is required before the IAP ships | The license proof (either kind) must follow the vault so a purchase on one device covers the user's other synced devices. M6 carries both proofs. Carrier choice (open question 3) is still @justin's to confirm. (@justin 2026-10-16) **Superseded by D28 (2026-10-16): M6 is deferred and the IAP ships without it.** |
| D17 (deferred 2026-10-19) | Buy everywhere: website where allowed, store purchase where not | Every device has a functional Buy button. Buy opens our website (FUTOpay checkout) wherever the platform allows a link without a paid program we chose not to join; where it does not, Buy runs the store's in-app purchase (StoreKit, Play Billing). Supersedes ADR-0005's "key-only, no Buy" surfaces and D6. The routing table is § 7b M7.0, owned by one Rust function (D8). (@justin 2026-10-16) |
| D18 (deferred 2026-10-19) | Refunds are out of scope | Nothing is designed for revocation: no refund handling, no tombstone-for-refund, no revocation or OCSP checks. A stored proof keeps verifying. (@justin 2026-10-16) |
| D19 (deferred 2026-10-19) | No server work | FUTOpay/lib-polar is unchanged. A store purchase is never converted to a FUTOpay key and never sent to FUTO; the store's signed proof (Apple JWS, Google signed purchase) is verified offline in Rust and travels by license sync (M6, required before any IAP ships). This rejects § 7c. (@justin 2026-10-16) **Amended by D28:** "travels by license sync" now reads "would travel by license sync once M6 exists"; until then the proof stays on the device and moves only by same-store Restore. **Superseded by D29 (2026-10-16): § 7c is adopted; lib-polar gains the redeem endpoints.** |
| D20 (deferred 2026-10-19) | Sandbox purchases are accepted when the app is not an App Store install | Q7 resolved: yes. The iOS shell reports `AppTransaction.environment`; Android and desktop are never App Store installs. A production store install never accepts a Sandbox proof. (@justin 2026-10-16) **Superseded by D29:** the client has no Sandbox rule; production FUTOpay accepts Sandbox transactions (App Review needs it) under the containment in § 7c.2 and Q12. |
| D21 (deferred 2026-10-19) | US iOS: Buy points to the website | Q6 resolved. IAP and Restore stay in the binary (§ 7b, D-C). (@justin 2026-10-16) |
| D22 (deferred 2026-10-19) | Google Play proof is verified offline | The signed `Purchase.getOriginalJson()` + `getSignature()` is verified in Rust against the app's Play Console public key; acknowledgement is client-side. No Developer API call, no server. § 7b M7.1, M7.3. **Superseded by D29:** the signed purchase is sent to lib-polar, which verifies the same signature and answers with a FUTOpay key (§ 7c.5). |
| D23 (deferred 2026-10-19) | Google Play uses Play Billing everywhere | D-A resolved: the `play` build never links out, in any region (no External Content Links, External Offers or billing-choice enrollment). (@justin 2026-10-16) |
| D24 (deferred 2026-10-19) | Apple EU, Japan and Brazil use the in-app purchase | D-B resolved: no link-out entitlements; every non-US storefront runs StoreKit. (@justin 2026-10-16) |
| D25 (deferred 2026-10-19) | US iOS keeps IAP and Restore live behind the website Buy | D-C resolved as recommended: a secondary US "Buy in the App Store" is added only if App Review objects. (@justin 2026-10-16) |
| D26 (deferred 2026-10-19) | A store proof shows its source on the Licensed card | Q10 resolved: "Purchased via the App Store / Google Play, {date}", no key. (@justin 2026-10-16) **Superseded by D29:** a store purchase ends as an ordinary FUTOpay pair, so the Licensed card is the normal key card (tap-to-reveal and all); no source line. |
| D27 (deferred 2026-10-19) | No second Play app | Q11 resolved: no `com.futo.notes.dev` Play app. Real purchase testing uses `com.futo.notes` on the internal testing track with license testers; debug builds and automated tests use a fake `BillingClient`. A `.dev` build never runs a real Play purchase. (@justin 2026-10-16) |
| D28 (deferred 2026-10-19) | Punt on license sync (M6) | M6 is **deferred, not cancelled**, and the store purchases (M7) no longer wait for it. Supersedes D16; amends D10 and D19. Without M6 a license is per device, as today. A store purchase reaches the user's other devices **on the same store** through that store's Restore (Apple ID across iPhone and iPad; Google account across Android Play installs). It does **not** reach other platforms: an App Store purchase does not license Android or desktop, and a Play purchase does not license iOS or desktop. A website/FUTOpay key still works anywhere it is entered. Consequence for copy: the store-purchase card copy and any "your license is on all your devices" claim are off-limits. (@justin 2026-10-16) **Amended by D29:** a store purchase now yields a real key, so it reaches any platform the way a website key does (type or paste the key, which the card reveals); still nothing travels on its own until M6. |
| D29 (deferred 2026-10-19) | **Store purchases are redeemed for a FUTOpay key (§ 7c adopted, for both stores)** | Supersedes D15's "no server work", D19, D20, D22 and D26; ADR-0007 items 4, 5, 7, 8 are superseded by [ADR-0008](../adr/0008-store-purchases-are-redeemed-for-a-key.md). On a StoreKit or Play Billing purchase the app makes **one user-initiated POST** to FUTOpay (lib-polar) carrying the store's signed proof; the server verifies it (Apple's own library for the JWS; the Play public-key signature for Google), mints or re-serves a key through the existing `create_key_func`, and answers `{license_key, activation}`. The client then holds **only FUTOpay pairs**, everywhere, verified by the unchanged `evaluate`: no `LicenseProof` enum, no Apple roots in the binary, no Rust chain verifier. Restore re-redeems and gets the same key back. Until the redemption succeeds the card shows a pending state with Try again; the transaction stays unfinished and the Play purchase unacknowledged. Refunds stay out of scope (D18). M6, when picked up, carries one proof kind. Costs accepted: a FUTOpay dependency at purchase, at Restore and during App Review; the JWS or Play receipt leaves the device (to FUTO only); one lib-polar MR (M8) that must be live in production before a store submission. (@justin 2026-10-16) |
| D30 (deferred 2026-10-19) | Sandbox containment on production FUTOpay | Q12 resolved: (a) now, accept Sandbox transactions and flag the row `environment=Sandbox` for audit; (b) short-expiry v2 activations for Sandbox redemptions once `feat/futo-notes-v2-activation` lands. Google's twin (the Developer API) stays unbuilt. (@justin 2026-10-16) |
| D31 (deferred 2026-10-19) | The pending card never retries on its own | Q13 resolved: no. Buy, Try again and Restore are the only three network triggers; no retry on launch, on opening Settings or on opening the card. (@justin 2026-10-16) |
| D32 (deferred 2026-10-19) | One lib-polar MR | Q14 resolved: Apple (L1-L6) and Google (L7-L10) land together in a single lib-polar MR, deployed to staging as one, then production as one. (@justin 2026-10-16) |

## 1. The picker when the license does not include icons (M2, M3)

Concept A (D11), `license-cosmetics/02-picker-unlicensed.png`. The resting picker is unchanged in
shape: two-column grid, six labeled tiles, the current choice checked.

- Every tile except the current one wears a small coin badge (the existing
  `SupporterCoin` artwork, 26pt, bottom-trailing of the artwork, surface-colored ring).
  Tiles are **not** dimmed and **not** disabled: a cosmetic should look like what it is.
- A footnote under the grid: `settings.appIcon.license.footnote`.
- Tapping a badged tile opens a sheet over the picker (iOS: `.sheet` with a medium detent;
  Android: a second `ModalBottomSheet`): the tapped icon's artwork with the coin badge, the
  title `settings.appIcon.license.sheetTitle`, one paragraph, one filled button, text links.
  - Link-out: paragraph `settings.appIcon.license.sheetBody`; filled **Buy a license**
    (`license.buy`, or `license.renew` when Expired) → opens the Buy URL with
    `from=app-icon` (M4) exactly the way the License card opens it today (default browser
    on iOS, Custom Tab on Android `direct`); links **I already paid** (`license.enterKey`)
    → dismisses the sheet and the picker, scrolls Settings to the License card, opens the key
    field; **Not now** (`settings.appIcon.license.notNow`) → back to the grid.
  - Key-only: paragraph `license.keyOnlyExplanation`; filled **I already paid**; link **Not
    now**. No other control, no other copy.
  - Which shape is Rust's answer: reuse `license_row_actions(status, link_out)` — if it
    contains `Buy`/`Renew` the sheet is link-out, else key-only. No new storefront logic.
- Tapping the current tile is a no-op, as today.
- The Settings row gains a trailing coin + `settings.appIcon.license.rowHint` before the
  chevron while the license does not include icons (`01-settings-row-hint.png`). The License
  card itself does not change (D12).
- The sheet is `03-tap-sheet.png`, both builds.
- Licensed (D13, right half of `04-after-activation.png`): the footnote, the sheet and the row
  hint disappear; the coin badge stays on every tile but Standard. Tapping a tile changes the
  icon exactly as today.

## 2. M1 — the Rust rule and its projections

`crates/futo-notes-license`:

```rust
/// What a license includes beyond the card. Cosmetic only, by policy (D1, license.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseInclusion { AppIcon }

/// The one place the policy lives. Licensed → everything; Unlicensed and Expired → nothing.
pub fn license_includes(status: LicenseStatus) -> Vec<LicenseInclusion>
```

- Tests: Licensed includes `AppIcon`; Unlicensed and Expired include nothing; the list is
  stable (snapshot) so adding a variant is a deliberate edit.
- `futo-notes-ffi` license contract: export `license_includes` and `LicenseInclusion` as a
  `uniffi::Enum`, next to `license_row_actions`. Contract test mirrors the Rust one.
- Tauri: `includes` rides on the `LicenseView` the existing license commands already return
  (computed in Rust through `license_includes`, off `LicenseState::status()`); TS reads it
  from the view, no second IPC call. Desktop renders nothing from it yet.
- Shells: `LicenseModel` (Swift/Kotlin) exposes `includes: Set<LicenseInclusion>` derived from
  `view.status` through the FFI call, updated wherever `view` is assigned (load, apply,
  remove, full reset). `AppIconController` does **not** learn about licenses; the picker view
  reads `license.includes.contains(.appIcon)` and branches between the two renderings. Keep
  the icon-change mechanics (`select`, confirm dialog, readback) untouched.
- Rewrite the policy text: `docs/spec/license.md` § Principles ("Nothing is gated" → "Nothing
  that works is gated" + the inclusion rule), line 4 of the same file, line 637's copy claim,
  `crates/futo-notes-license/AGENTS.md:9`, `crates/futo-notes-license/src/lib.rs:4`,
  `apps/ios/Sources/License/LicenseSettingsSection.swift:83`,
  `src/features/license/LicenseSettingsSection.svelte:9`, the ship plan's line 278 (deleted; commit 0774e8a2e).
  Add `docs/adr/0006-a-license-may-include-cosmetics.md`.
- Spec: new lines in `docs/spec/license.md` (a "What a license includes" section, platform
  tagged) and `docs/spec/settings.md` § Native app icons (the unlicensed rendering, the sheet,
  the row hint, D2, D3). `settings-visual.md` § Native app icon picker gets the badge and
  sheet geometry.

Verification: `cargo test -p futo-notes-license -p futo-notes-ffi`, `just check`.

## 3. M2 iOS, M3 Android — the picker

- iOS: `AppIconPicker.swift` grows the badge (both states, D13), the footnote and the sheet
  (unlicensed only); `SettingsView.swift` the row hint. `LicenseSettingsSection.swift` is
  untouched (D12). Tests: `AppIconPickerTests` (rendering per status, which is a pure function
  of `includes` + `rowActions`), a UI test in `AppIconTests` that taps a badged tile on a
  forced-Unlicensed build and sees the sheet, then forces Licensed and sees the grid with
  badges and no footnote. Storefront forcing already exists (`-FUTOLicenseStorefront`).
- Android: `AppIconSheet.kt` the same; `SettingsScreen.kt` the row hint;
  `LicenseSettingsSection.kt` untouched. Tests: `AppIconSheetTest` (Compose, both renderings,
  both flavors). The existing "Change app icon to …?" confirm stays after the license check,
  untouched. Android sketch: `05-android-and-second-device.png`, left.
- Accessibility: a badged tile's label becomes "{name}, included with a license"
  (`settings.appIcon.license.a11yIncluded`); the sheet's title is its heading.
- Catalog: every string in § 6, English only, `pnpm run check:languages`.

Verification: `just ios-native` + the suites above; `just android-native` on both flavors +
`AppIconSheetTest`; a device pass on each per `apps/*/AGENTS.md` with screenshots of the four
renderings (unlicensed link-out, unlicensed key-only, sheet, licensed).

## 4. M4 — attribution on the Buy URL

`buy_url(config, platform)` becomes `buy_url(config, platform, source)` with

```rust
pub enum BuySource { LicenseCard, AppIconPicker }
```

serialised as `&from=license-card` / `&from=app-icon`, after the existing `platform`. Every
caller names its source; there is no default. `license_links` grows a `source` parameter;
the desktop command and both shells pass it.

- It rides the click the user already makes: no new request, nothing stored, nothing sent
  without a tap. State this in the spec next to the zero-background-network principle.
- The deployed server does not record `platform` yet (license.md Gap). **Before M4 lands**,
  confirm with the FUTOpay/lib-polar owner which query parameters `checkout-ready` forwards
  into Polar order metadata and under what names, and write the answer into the Gap. If
  `from` is dropped on the floor, M4 is still correct and still cheap, but the Gap says so.
- Tests: the two URLs are exact-string tested per source and per environment; the contract
  test `the_buy_url_carries_the_platform` grows a sibling for `from`.

Verification: `cargo test -p futo-notes-license -p futo-notes-ffi`; open each Buy on a dev
build and read the URL in the browser's address bar.

## 5. M5 — land on the reward after activation

Native only. When an activation succeeds (deep link, cold or warm; or a bare key / pair entered
on the card) **and** the new `includes` contains `AppIcon` **and** the shell has a picker:

1. The existing toast `license.activated` still shows.
2. Settings is presented if it is not already (the deep link can arrive on the list), and the
   picker is opened over it, with a one-time header above the grid: the coin,
   `license.explanationLicensed` in bold, `settings.appIcon.license.landing` under it
   (`04-after-activation.png`, left). The coin badges are already on the tiles (D13).
3. The header exists only for this presentation. Dismissing the picker and reopening it shows
   today's plain grid. Nothing is persisted; there is no "seen" flag.
4. If the picker is already open (the user went Buy from the sheet, or typed a key after
   "I already paid"), the sheet dismisses itself and the grid re-renders licensed, with the
   same header.
5. M1 rule: the shell has already rendered before a cold-start link is applied; the picker is
   presented after, never gating the shell.
6. Android's "FUTO Notes may close" confirm stays on the first tap. An interrupted alias
   transition is reconciled by the existing startup observation; nothing new.
7. If the OS cannot change icons (iOS `supportsAlternateIcons == false`), skip the landing
   entirely: the picker would only show `settings.appIcon.unavailable`.

Tests: iOS `LicenseModelTests` + a UI test driving `futonotes://license/…` with the staging
fixture and asserting the picker is on screen with the header; Android `LicenseLinkActivity`
→ `MainActivity` path with the same assertion in `AppIconSystemTest`. Spec lines in
`license.md` § Deep link and `settings.md` § Native app icons.

## 6. Catalog entries

| Key | English |
|---|---|
| `settings.appIcon.license.rowHint` | With a license |
| `settings.appIcon.license.footnote` | Purchasing a FUTO Notes license unlocks the ability to change the app icon. |
| `settings.appIcon.license.footnoteKeyOnly` | Choosing an app icon is included with a FUTO Notes license. (key-only builds) |
| `settings.appIcon.license.sheetTitle` | Included with a license |
| `settings.appIcon.license.sheetBody` | Purchasing a FUTO Notes license unlocks the ability to change the app icon. |
| `settings.appIcon.license.notNow` | Not now |
| `settings.appIcon.license.landing` | Your license includes choosing your app icon. Pick one. |
| `settings.appIcon.license.a11yIncluded` | {iconName}, included with a license |

Reused: `license.buy`, `license.renew`, `license.enterKey`, `license.keyOnlyExplanation`,
`license.activated`, `license.explanationLicensed`, `license.coinAccessibilityLabel`.

## 7. M6 — the license follows the vault (DEFERRED by D28; ask-first; own MR)

**Deferred 2026-10-16 (D28).** M6 is not scheduled and M7 does not wait for it. Everything below is kept for when it is picked up: the feasibility note, the decided carrier (Q3: the hidden engine slot), and the rules. The "REQUIRED" wording below is historical (D16, superseded). Without M6 a license is per device, as today. A store purchase reaches the user's other devices **on the same store** through that store's Restore (Apple ID across iPhone and iPad; Google account across Android Play installs). It does **not** reach other platforms: an App Store purchase does not license Android or desktop, and a Play purchase does not license iOS or desktop. A website/FUTOpay key still works anywhere it is entered. **D29 (same day):** a store purchase is redeemed for a FUTOpay key, so M6 only ever carries one proof kind (the pair) and the three-kind text below is historical; § 7c.3 "M6 gets smaller" is the current shape. A store buyer reaches another platform today by revealing the key on the card and entering it there, as with a website key. **2026-10-19:** store purchases are deferred (§ 7b, § 7c), so every statement above about a store purchase is part of that record; a license today is a website key, per device.

Problem: the license is entered per device (license.md Gap "License sync"). Once a license
includes something visible, a second phone that is synced but Unlicensed reads as broken. Since
D15/D16 this is **required**: an App Store purchase proof is bound to an Apple account and is
otherwise useless on the buyer's Android phone or desktop. M6 carries "the license proof", which
is either the FUTOpay pair or an App Store signed transaction (a JWS string, a few KB). The
carrier is the one the Feasibility note below recommends (option (a): a dedicated engine slot at
a reserved non-note path); **confirming it is still @justin's call (§ 9, Q3)**, and M6 does not
start before that OK. Additions for the other proofs (three kinds now: FUTOpay pair, Apple JWS, Google signed purchase; D17-D19). **Carrier confirmed 2026-10-16: the hidden engine slot, never a file.** With refunds out of scope (D18) any valid proof counts, so duplicate copies simply keep one, and the one rule that remains is that a **Remove license tombstone wins over an offline device** that still holds the proof. The slot may hold one proof per kind; a device never drops its own valid proof because a pulled one fails to verify there (e.g. a Sandbox proof on a production store install). The refund-driven parts below ("no revocation signal", tombstone-for-refund) are void:

- The object holds a small tagged value (`{"kind":"futopay-pair",...}` or
  `{"kind":"apple-jws","jws":"..."}`). One object, one proof: when a device holds both, publish
  the one `evaluate` ranks Licensed, preferring the FUTOpay pair (portable, carries `issued_at`).
- A pulled proof of either kind goes to Rust `evaluate` as if typed or bought; nothing is trusted
  for arriving by sync. A synced Apple proof verifies on **Android and desktop** too: it is pure
  Rust, offline, no Apple call. On Android `play` that is allowed (Google lets any app be
  consumption-only: access bought elsewhere may be honored; it just cannot be sold there).
- A synced Apple proof gives **no revocation signal off iOS**. Only an iOS device that sees
  StoreKit report a revocation removes the proof and syncs the tombstone (the tombstone-wins rule, § 9 Q9); Android and desktop keep honoring the stored JWS until then.
- Self-hosted sync: unchanged, the object is an opaque encrypted blob on any server.
- Users without sync keep a per-device license. State this in the spec; do not paper over it.

Proposed shape, to be confirmed before any code:

- The stored pair (key + activation) travels inside the E2EE vault as one small encrypted
  object, the same way a note's bytes do, so the server keeps seeing opaque blobs and the
  hosted and self-hosted servers need no change. **First task is to establish whether the
  sync crate can carry a non-note object today** (the vault model is note-shaped:
  `sync/vault.rs`, `sync/encrypted_note.rs`). If it cannot, the options are (a) a reserved,
  hidden vault path the store never lists as a note, or (b) a new object kind in the
  protocol, which also touches the server repo. Write the answer into this section before
  choosing; (a) is the preference if the store's listing and the editor can be kept from
  ever seeing it.
- Entering a key on any device publishes the pair on the next push. A pull that delivers a
  pair hands it to Rust `evaluate` exactly as a typed key would; the dev/prod split holds
  (a production pair in a `.dev` build verifies as Unlicensed, correctly). Nothing is trusted
  because it arrived by sync; verification is the same RSA check.
- **Remove license** on any device removes the synced copy too: one vault, one license.
  Last-writer-wins on the object; a conflict between two different valid pairs keeps the one
  with the later `issued_at`, else the later write.
- A device that receives a pair runs the M5 landing only if it is in the foreground and in
  Settings; otherwise just the toast. Never present UI from a background pull.
- Zero background network stays true for the license module: the pair arrives through the
  sync cycle the user already configured; the license crate still makes no call of its own.
- Spec: license.md Gap closes; sync.md gains a "What travels besides notes" line; the
  conflict rule gets a line in § Conflict & data safety.

Verification: the cross-platform sync harness (`tests/cross-platform-sync.mjs`, `tests/sync-integration.mjs`), two emulators/simulators, a
desktop + phone pair; `just test-rust`.

### Feasibility (2026-10-15)

Read-only research; no code changed. Recommendation only. Justin's call: M6 is not now
(own MR later), so this records what the later MR must do.

**Can the sync crate carry a non-note object today? No, not without engine changes. The
server can carry it; the client engine cannot.**

- The server is already kind-agnostic. An object is `id, version, change_seq, deleted,
  blob_key, size_bytes, timestamps` (`futo-notes-server/internal/objects/objects.go:25`;
  `docs/Rewriting the server in Go.md` § objects). There is no path or kind column: the path
  lives only inside the encrypted blob. The server validates only blob size (100 MiB,
  `internal/config/config.go:104`) and batch size (32 MiB). A listing exposes only opaque ids
  and sizes, so a hidden path leaks nothing, and self-hosted servers need no change for (a).
- The client engine is file-shaped end to end. The blob frame is `pack_note_v2(path, content)`
  (`futo-notes-core/src/e2ee/note_frame.rs:11`). A pulled object is classified by path
  (`classify_incoming_sync_path`, `futo-notes-core/src/files/paths.rs:89`); anything that is
  not `.md` or an image is `Ignore`d silently (`paths.rs:95`; `sync/pull/apply_remote.rs:50-62`:
  no failure, nothing written, nothing mapped). Push enumerates the disk (`sync/vault.rs:100`
  skips every dot entry, `:130` skips non-syncable names), and deletion only considers
  `is_syncable_filename` names (`sync/push/delete_local.rs:73`). So a non-note object is
  never pushed, never tracked in `object_map` (keyed by file name, `checkpoint.rs:41`), and
  never deleted by today's engine. Create, update, tombstone and conflict handling all hang
  off that map and the disk scan.
- Nothing else non-note travels today except images (same note frame, base64; `sync.md`
  § Embedded images). Folders are implied by note paths; settings, non-image attachments and
  folder metadata do not sync. `.e2ee-state.json` is a vault dotfile that is per-device state
  and is not synced.

**What the rest of the app would see.** Dot-prefixed entries are already invisible: store
listing (`futo-notes-store/src/vault.rs:333`, `:401`) and sync scan (`sync/vault.rs:100`), and
search/index/editor read the store listing. I found no iOS/Android/desktop directory walk that
bypasses the Rust store. A reserved path that is never a file on disk cannot be listed by any
of them. (Not verified at runtime.)

**Option (a): reserved hidden path, carried as a side channel rather than a file.**
- Path: a non-syncable extension, e.g. `.futo/license.json`, in the normal note frame. It must
  NOT end in `.md` or an image extension: an old client would `Accept` that and write it to disk.
- Do not materialise it as a file. The push scan skips it and delete-detection would read it as
  "missing locally". Keep it out of `object_map` and add one dedicated slot to `ConnectedState`
  (e.g. `license_object: Option<ObjectState>`; plain serde, `checkpoint.rs:35`, no
  `deny_unknown_fields`, so an older client reading the state file ignores it), with a hook in
  push (publish when the local pair changed or was removed) and in pull (recognise the reserved
  path before `classify_incoming_sync_path`, hand the pair up through the summary, write no
  file). This is a real sync-engine change: push-first ordering applies (publish after notes in
  the same cycle) and AGENTS.md §11.6 (sync payload) makes it ask-first.
- Listings to filter: none in store/search/editor if no file exists. The only new filtering is
  inside the engine (pull classifier, object-map pruning, `delete_missing`).
- Conflict/LWW: the server gives per-object optimistic versions (stale PUT returns 409) but
  does NOT enforce path uniqueness. Two devices entering a key offline each POST a new object
  at the reserved path, i.e. two objects. The existing path-collision rule
  (`sync/collision_resolution.rs:28`: lowest object id wins, loser becomes a conflict copy) is
  note-shaped and must not be reused. The license needs its own rule (later `issued_at`, else
  later write, as § 7 says) and must tombstone the losing duplicate; a 409 re-reads the remote
  pair and re-applies the same rule. New merge code in a crate that merits `/slow-review`.
- Deletion: "Remove license removes the synced copy" is a normal DELETE of that one object
  (tombstone). Peers pull it and drop their pair. Gap: a device offline during Remove keeps its
  pair and would republish it on its next push, resurrecting the license. The rule needs
  tombstone-wins (never republish a pair whose object was tombstoned after it was last synced),
  otherwise "one vault, one license" does not hold. Decide this explicitly.
- E2EE: unchanged. AES-GCM under the vault key like every note; the server sees an opaque blob
  of a few hundred bytes. Every synced device holds the vault key, so any of them can read the
  pair; that is inherent and matches "one vault, one license".
- Self-hosted: works on any server that accepts a normal object; no change to
  `scripts/sync-server-pin.json`.
- Mixed-version clients: an OLD client downloads and decrypts the object, then `Ignore`s it
  (`IGNORE_NOT_A_NOTE`): no failure, no journal line, no file, no map entry. It never publishes
  or removes it, so old devices simply stay per-device licensed. Needs a mixed-version run to
  confirm (CI never pins that pairing).

**Option (b): a new object kind.**
- Server `kind` column: migrations for both Postgres and SQLite
  (`internal/db/migrations/{postgres,sqlite}`), API/OpenAPI and listing changes, a server
  release and a pin bump. Self-hosters on older servers silently lose the feature, and the
  hosted deploy must be coordinated. The server never interprets content, so it buys nothing.
- Client-only variant (a new frame byte, e.g. `0x03`): worse for old clients. `unpack_note`
  returns `UnknownFrame` (`note_frame.rs:41`), which `decrypt_bytes` turns into
  `FailureKind::Decrypt` (`encrypted_note.rs:53`): a loud pull failure on every old device that
  may also hold the pull cursor back (`pull/mod.rs:41`). The cursor stall is unverified; treat
  it as a risk to test.

**Risks.** (1) The engine change is real even for (a): the crate has no notion of a non-file
object. (2) The duplicate-object race and offline-Remove resurrection need the explicit rules
above. (3) A `.dev` and a prod build sharing one vault would publish/remove each other's pair;
decide whether a build publishes a pair it cannot verify. A prod pair in a `.dev` build is
simply Unlicensed, as § 7 says. (4) Spec debt: sync.md "What travels besides notes", the
conflict-rule line, license.md Gap, a `tests/cross-platform-sync.mjs` scenario, and
`/sync-adversarial`.

**Recommendation (not a decision).** When M6 is picked up: option (a), a reserved non-`.md`
path (`.futo/license.json`) carried by a dedicated engine slot rather than a vault file. It
leaves the server and self-hosted compatibility untouched, old clients ignore it silently, and
nothing in store/search/editor can see it because no file exists. Reject (b): it needs a server
release for something the server cannot interpret, and the in-frame variant breaks old
clients loudly. Also reject a reserved hidden *file* in the vault: the scan skips it and
delete-detection would treat it as gone. Open for the later MR: the offline-Remove rule.

## 7b. M7 — Buy everywhere: website where allowed, store purchase where not (does not wait for M6, D28; own MRs)

> **Deferred 2026-10-19.** In-app purchase (StoreKit, Play Billing) is not being built now; the
> routing below does not apply and nothing in this section is a task. Kept whole as the record.
> What ships is the key-only and link-out posture of ADR-0005.

Decisions D15-D29; [ADR-0007](../adr/0007-ios-sells-the-license-in-app.md) for the routing and
the store surfaces, [ADR-0008](../adr/0008-store-purchases-are-redeemed-for-a-key.md) for what a
purchase becomes. Rewritten 2026-10-16 twice: from "M7 — in-app purchase on iOS", then again under
D29, which replaced the offline Rust verifiers of M7.1 with the server redemption of § 7c. Scoping
only; nothing started. M6 is deferred (D28) and is not a dependency: a store purchase ends as a
FUTOpay key, Restore is the automatic cross-device path on the same store, and the key itself goes
anywhere a website key goes.

**The rule (D17).** Every device has a working Buy button. Buy opens our website (the FUTOpay
checkout) wherever the platform's rules allow a link without a paid program we chose not to join;
where they do not, Buy runs the store's own in-app purchase. Refunds are out of scope (D18): no
revocation handling anywhere. **A store purchase becomes a FUTOpay key (D29):** the store's signed
proof is sent once, on the user's tap, to lib-polar, which verifies it and answers with an ordinary
key + activation; the client never verifies a store proof itself. The server design, the lib-polar
task list and the Google half are § 7c; this section is the client and the store setup.

### M7.0 Routing table (rules read 2026-10-16; re-read before each submission)

| Surface | Buy does | Basis |
|---|---|---|
| iOS, **US** storefront | **Website** (default browser). Restore Purchases still shown. | Guideline 3.1.1(a): no entitlement needed for buttons/links in US storefront apps (Apple, App Review Guidelines, read 2026-10-16). Commission on US link-outs is 0% today; Apple proposed 5-15% in Aug 2026, undecided before the district court, and Apple's merits brief to the Supreme Court was filed 2026-09-14 (9to5Mac 2026-10-12; AppleInsider 2026-08-13). Decision @justin 2026-10-16. |
| iOS, **EU** storefronts | **StoreKit IAP** (decision D-B: recommend) | A link needs the EU entitlement under the unified EU terms effective 2026-10-01: 15% (10% Small Business) on sales within 7 days of the tap, 5% Core Technology Commission, monthly transaction reports, self-remitted tax (Apple, apps-in-the-EU page, read 2026-10-16; the page was ambiguous on one fee line). |
| iOS, **Japan** | **StoreKit IAP** (D-B) | Link allowed since iOS 26.2 (2025-12-17) at 15% (10% reduced programs) but always presented **alongside** IAP, and no refunds for those sales (Apple Newsroom 2025-12-17). Same commission as IAP at the Small Business rate, plus reporting: nothing gained. |
| iOS, **every other storefront** (and unknown) | **StoreKit IAP** | 3.1.1(a): buttons, links and other calls to action to non-IAP purchase are banned outside the US and the entitlement storefronts. Brazil has an entitlement; treated like the EU (D-B). Unknown storefront fails closed to IAP. |
| Android **`direct`** (GitLab, Obtainium, F-Droid) | **Website** (Custom Tab) | Distributed outside Google Play; no Play policy applies (ADR-0005, unchanged). |
| Android **`play`**, **US** | **Play Billing** (D-A: recommend) | Google says it will not prohibit US developers from linking out or promoting outside pricing since 2025-10-29 (Play Console Help 15582165, read 2026-10-16), but the formal vehicle is the **External Content Links** program: enroll, integrate its APIs, report every transaction (from 2026-10-01, download-fee deadline moved to 2026-12-01 on 2026-09-17), fees on purchases within 24 h of a tap (Play Console Help 16470497; listed rates 10-20%). Whether an un-enrolled US link is safe from enforcement is not settled by any page we found. |
| Android **`play`**, **EEA / UK** | **Play Billing** (D-A) | A link needs External Offers (EEA) or the **billing choice program** (EEA and UK since 2026-06-30): Play Billing must still be offered alongside, 20% on one-time purchases from new installs, reporting within 24 h, refund/support obligations (Play Console Help 17161464). Google Play Billing in these regions carries service fee plus 5% billing fee (Help 112622). |
| Android **`play`**, **Japan / Australia** | **Play Billing** | Billing choice program from 2026-09-30, same obligations. |
| Android **`play`**, **elsewhere** | **Play Billing** | Payments policy §4: apps may not lead users to a payment method other than Play Billing outside a program (Help 9858738). Consumption-only apps may only say where to buy, without a link (Help 10281818), which is not a functional Buy (D17). |
| Desktop (Tauri; macOS, Windows, Linux) | **Website** | Not distributed through a store that governs payment (no Mac App Store or Microsoft Store build exists today; re-check if one is ever added). |
| Web | none shipped | `openExternalUrl` falls back to `window.open` only for the dev server; if a web client ever ships: Website. |

Decisions for @justin (costs as read 2026-10-16; figures from Google's help pages conflict between
pages and secondary summaries, so confirm in Play Console before deciding):

- **D-A, Google Play where a link is only possible through a paid program (US, EEA, UK, later Japan/Australia).**
  (a) Enroll and link out: US External Content Links, EEA/UK billing choice or External Offers. Cost:
  the program fee (about 20% of a one-time purchase made within 24 h of the tap in the sources
  read; 10-20% listed for US), plus the program's API integration and per-transaction reporting
  into the `play` flavor, refund/support/dispute obligations, and, for EEA/UK, **Play Billing
  still has to be built** because the choice must be offered. (b) Use Play Billing there: service
  fee plus 5% billing fee as listed for US/EEA/UK on Google's fee page (20% + 5% for new installs on the
  page as fetched; a secondary summary says 10% on the first $1M; rest of world 15% on the first
  $1M). The saving from (a) is at most the 5% billing fee, against an extra integration and
  reporting duty, and Play Billing has to exist anyway for the rest of the world.
  **Recommend (b) everywhere on `play` for v1**; revisit the US only after Google settles
  whether an un-enrolled link is acceptable and what ECL really costs after 2026-12-01.
- **D-B, Apple EU / Japan / Brazil.** (a) Apply for the link entitlement: about the same commission
  as IAP, plus disclosure sheet, monthly reporting, self-remitted tax, parental gate rules, and in
  Japan an IAP twin anyway. (b) StoreKit IAP. **Recommend (b).**
- **D-C, US iOS and guideline 3.1.3(b).** The US storefront shows Buy to the website, as decided.
  Guideline 3.1.3(b) legitimises a key field because the thing is "also available as in-app
  purchase"; in the US the argument rests on 3.1.1(a) instead. Keep the StoreKit product, Restore
  Purchases and the verifier live in the US build (they are the same binary). If App Review
  objects, the fallback is a secondary "Buy in the App Store" button in the US, not a rewrite.
  **Recommend: ship as decided; put the 3.1.1(a) argument in the review notes.**

### M7.1 Rust (`crates/futo-notes-license`, `crates/futo-notes-ffi`): redemption and routing (size S-M)

Under D29 there is **no** `LicenseProof` enum, no Apple roots, no JWS or Play verifier and no
`evaluate` change in this repo: a store purchase is redeemed for a pair and the pair goes through
today's code byte for byte. The offline-verifier design that stood here between D15 and D29 is in
the git history of this file and in ADR-0007; it is not carried forward.

**Redeem workflow.** `redeem_store_purchase(receipt: StoreReceipt, config, transport) ->
Result<AcceptedLicense, RedeemError>` next to `enter_license_key`, with
`StoreReceipt::AppStore { jws } | GooglePlay { original_json, signature }`. It builds one `POST`
(`redeem_url(config, store)`, joining the existing `activation_url` in `config.rs` so host and org
key are selected together by `Environment`), sends the receipt as JSON, parses
`{"license_key", "activation"}`, and hands the pair to the existing `evaluate` exactly as a typed
or deep-linked pair: product and key-prefix checks, the baked org key, the dev/prod split. The
server's answer is untrusted until the signature verifies, so a wrong or hostile server cannot
make anything Licensed. Reuses `AcceptedLicense`. Nothing is stored before `evaluate` says
Licensed.

**Answers map as:** 200 with a verifying pair -> Licensed (store it, finish/acknowledge); 200 with
a pair that does not verify, or 4xx (bad receipt, wrong bundle/package/product/environment) ->
`RedeemError::Rejected` ("couldn't verify this purchase", nothing stored, transaction left
unfinished, support path); transport failure or 5xx -> `RedeemError::Unavailable` (pending state,
Try again). No retry inside Rust; a retry is a tap.

**Transport.** `ActivationTransport` is GET-only today; add `post_json` (same timeouts, no
redirects, no retry) and implement it in `Pay2Transport`
(`crates/futo-notes-ffi/src/license/transport.rs`). The "exactly one GET" rule in
`crates/futo-notes-license/AGENTS.md` and in license.md § Principles becomes "at most one request
per explicit user action: a bare key's GET, or a redemption's POST". The "unavailable" transport
that panics on any request stays for every offline path, so a new network call still fails loudly
in tests.

**FFI.** `license_redeem_app_store(jws, bundle_id)` and `license_redeem_google_play(original_json,
signature, package_name)` in `contract.rs`, mirroring `license_enter_key`. Tauri gets nothing:
desktop never purchases from a store.

**Config.** `LicenseConfig` gains nothing store-specific beyond the redeem path; the Apple app id,
Play public key and product maps live on the server (§ 7c.2, § 7c.5). Product ids stay client
constants next to `PRODUCT_SLUG` (one per store, e.g. `futo_notes_license`) because the shells
need them to load the store product.

**Conformance.** Extend `tests/conformance/license.json` with redeem cases shared by Swift, Kotlin
and the Tauri shell: 200 with a signed pair -> Licensed; 200 with a tampered pair -> Rejected; 4xx
-> Rejected; 5xx and transport failure -> Unavailable; a Production pair in a `.dev` config ->
Rejected. No store fixtures live in this repo.

**Routing in Rust (D8).** Replaces `license_link_out(platform, storefront_country, build_allows) ->
bool` and the `link_out: bool` of `license_row_actions`:
`license_buy_route(distribution, region: Option<String>) -> BuyRoute { Website | StoreIap }` with
`distribution ∈ { Desktop, IosAppStore, AndroidDirect, AndroidPlay }` and `region` the iOS
`Storefront.countryCode` (ISO alpha-3) or, for Play, the Play country code (unused while D-A is (b);
keep the parameter so enrolling later is a table edit). Table: `Desktop`/`AndroidDirect` ->
Website; `IosAppStore` + `"USA"` -> Website, anything else including `None` -> StoreIap;
`AndroidPlay` -> StoreIap (D-A (b)). `license_row_actions(status, route)`: Unlicensed ->
`[Buy, EnterKey]` plus `LostKey` on Website or `Restore` on StoreIap; Expired -> `[Renew, ...]` the
same way; Licensed -> `[Remove]`. `LicenseAction` gains `Restore`. `LicenseLinks.buy` is empty
for StoreIap: the shell runs its store. `BuyRoute` rides the FFI; Desktop never returns StoreIap, so
the Tauri projection has no store path. The `none`/`USA`/`FRA` conformance cases stay and gain Play
and Direct rows. Key-only is no longer a shape: `link_out == false` disappears.

### M7.2 iOS shell (`apps/ios/Sources/License/`, size M)

- `LicenseStoreKit` (new): load the product; Buy runs `product.purchase()`; on `.success` the same
  tap continues into `license_redeem_app_store(jwsRepresentation)` (one POST, § 7c.1). Licensed ->
  store the pair, `transaction.finish()`, M5 landing. Unavailable -> keep the JWS in a **pending
  slot** in `LicenseStorage` (never evaluated, never shown as Licensed) and leave the transaction
  unfinished; the card shows "Purchase received, not yet activated" with **Try again** and
  **Restore**. Rejected -> store nothing, "couldn't verify this purchase", support path. `.pending`
  and `.userCancelled` are not errors. StoreKit's `.verified` is never our rule; the server's is.
- **Restore Purchases** (`AppStore.sync()`, then `Transaction.currentEntitlements`, redeem the
  license product's JWS the same way; the server is idempotent on `originalTransactionId`, so the
  same key comes back), shown on the StoreIap route and in the US as well, a button next to the key
  field. Required by 3.1.1. It is the automatic same-store path (iPhone to iPad on one Apple ID); the
  key the card reveals is the path to Android and desktop, as for any key.
- `Transaction.updates` observed for the app's life only to *deliver* an unfinished transaction
  into the pending slot; it never calls the network. Redemption is always a tap (Buy, Try again,
  Restore), so **Remove license** is not undone at the next launch and the zero-background-network
  principle holds (Q13: no retry-on-open either).
- `LicenseStorefront` keeps feeding the route (`license_buy_route`); the debug `-FUTOLicenseStorefront`
  override stays.
- Tests: `LicenseModelTests` with a fake store and a fake redeem (success; cancel; `.pending`;
  transport failure leaves the pending slot and the transaction unfinished; Try again succeeds;
  Restore returns the same key; 4xx stores nothing; Remove stays removed). A `.storekit`
  configuration file for UI tests with the redeem **faked**: the server cannot verify
  `XCODE`-environment transactions by design (§ 7c.2). The real end-to-end check is a Sandbox
  purchase on a TestFlight build of `com.futo.notes` against staging FUTOpay
  (`FUTO_LICENSE_ENV=staging`), which needs M8 on staging first.

### M7.3 Android shell, `play` flavor only (size M)

- **The `direct` APK must not depend on Play services.** The flavor already carries this audience
  (ZXing instead of ML Kit for the same reason, `app/build.gradle.kts`). Add
  `"playImplementation"("com.android.billingclient:billing-ktx:<current>")` (the integration page
  shows 9.1.0; new apps and updates need 8+ from 2026-08-31) and **only** there. Code split: an
  interface `LicenseStore` in main, `PlayLicenseStore` in `app/src/play`, a `NoLicenseStore` in
  `app/src/direct`; the build comment's "flavor source set is the third choice" applies and both
  flavors still compile. A Gradle check fails `direct` if its runtime classpath, its merged manifest
  (`com.android.vending.BILLING`) or its dex contains `com.android.billingclient`.
- **Flow.** `BillingClient` with `enablePendingPurchases(...enableOneTimeProducts())` and
  `enableAutoServiceReconnection()`; `queryProductDetailsAsync` (INAPP, do not cache `ProductDetails`);
  `launchBillingFlow`; in `onPurchasesUpdated` hand `getOriginalJson()` + `getSignature()` for each
  `PURCHASED` purchase to `license_redeem_google_play` (one POST, § 7c.5), on the same tap. Licensed
  -> store the pair, **then `acknowledgePurchase` immediately**, M5 landing. Unavailable -> keep the
  receipt in the pending slot, do not acknowledge, show the pending card with Try again and Restore.
  Rejected -> store nothing, do not acknowledge. PENDING (`purchaseState` 2) shows a "waiting for
  payment" line and grants nothing; Play delivers it as PURCHASED later through `queryPurchasesAsync`.
- **Restore.** `queryPurchasesAsync(INAPP)` after connect, on `onResume` and on the Restore tap
  (Google recommends it for network loss, multiple devices and PENDING-to-PURCHASED). A purchase
  found this way is **delivered into the pending slot**; redemption is a tap (Restore, Try again),
  never automatic (zero background network, as on iOS). The server is idempotent on `purchaseToken`,
  so a reinstall's Restore gets the same key back.
- **Acknowledgement is client-side, after the key verifies.** Google's page: acknowledge "on the
  client side through your app" is allowed, server-side is preferred; an unacknowledged purchase is
  **refunded automatically after three days**. Under D29 that is the right outcome: a purchase that
  was never redeemed (server down for three days, user never tapped Try again) refunds itself and
  nothing was granted. The residual failure is a crash between "pair stored" and "acknowledged";
  the acknowledge retry on every connect and `onResume` (no network of ours, it is a Play call)
  closes it within the three days. Server-side acknowledgement needs the Developer API and is not
  built (§ 7c.5).
- Region: only needed if D-A flips to enrolling (`getBillingConfigAsync` gives the Play country).
- Tests: a `BillingClient` fake behind `LicenseStore` plus a fake redeem (purchase ok; cancel;
  pending then purchased; already-owned; service disconnected; transport failure keeps the pending
  slot and does not acknowledge; Try again succeeds; acknowledge failure retried; Restore returns the
  same key). Play Billing has no replacement for the removed static test SKUs, so end-to-end runs use
  license testers on the internal track against staging FUTOpay (M8 on staging first).

### M7.4 UI and copy (size S, both shells plus Tauri strings)

- **The License card.** Unlicensed/Expired: `[Buy]`, "I already paid", and either "Lost your key?"
  (Website) or "Restore purchase" (StoreIap). Buy on StoreIap opens the store sheet directly (the
  sheet shows the price; copy never states one). **Pending** (new fourth state, native only):
  "Purchase received, not yet activated", `[Try again]`, `[Restore purchase]`, and the support line.
  Licensed: unchanged, the normal key card (D29 supersedes D26: a store purchase is a key like any
  other, tap-to-reveal and all).
- **The app-icon sheet** (D4, D11): under this design, Buy everywhere, with one sheet showing Buy
  and "I already paid". Deferred: the key-only sheet (`license.keyOnlyExplanation` plus "I already
  paid") stays as it ships today.
- **D5 vocabulary.** "Unlocks" is allowed on every surface: where a store forbids a link the license
  is sold through the store's own purchase, which 3.1.1 requires for unlocking, and Play Billing is
  Google's own path. Deferred: the link-out-only restriction on "unlocks" and the key-only variants
  stay.
  "free" and "donate" stay banned; "paywall" and "premium" stay banned.
- **Catalog strings.** Deferred, so none of this is done: `license.keyOnlyExplanation` and
  `settings.appIcon.license.footnoteKeyOnly` stay, and `license.unlicensedHeadline` and
  `license.explanation` stay suppressed on key-only surfaces. The design would have retired the
  first two and returned the last two everywhere.
  `settings.appIcon.license.footnote` and `sheetBody` ("Purchasing a FUTO Notes license unlocks...")
  now apply on every surface. Add: `license.restore` ("Restore purchase"), `license.restoreNothing`,
  `license.purchasePending` ("Purchase received, not yet activated"), `license.tryAgain`,
  `license.purchaseRejected` ("We couldn't verify this purchase", with the support line),
  `license.storeUnavailable`. `license.buy`, `license.renew`, `license.enterKey` are reused.
  Cancel shows nothing.
  Run `pnpm run check:languages`; drop the key-only assertions in `LicenseSurfaceTests`,
  `LicenseSurfaceTest` and `licenseCopy.test.ts`.
- ADR-0006's D6 line ("key-only builds get...") and ADR-0005's key-only rows would have been
  superseded by ADR-0007; with it deferred they stand.

### M7.5 Store setup (human checklist, @justin; no agent can do it)

**App Store Connect**
1. Agreements, Tax and Banking: Paid Apps agreement signed, bank and tax forms done (IAP cannot be
   tested for real without them; sandbox works earlier).
2. Join the **Small Business Program** if eligible (15% instead of 30%); confirm the rate.
3. Create the **non-consumable** IAP with the product id the Rust constant names, the license price tier,
   Family Sharing off, localized name and description, review screenshot.
4. Sandbox tester accounts; a TestFlight build. Copy the app's numeric **Apple ID** (App Store
   Connect > App Information) into the lib-polar config (`APPLE__APP_APPLE_ID`, § 7c.2).
5. Review notes: free app; the license is one non-consumable IAP; Restore Purchases and the key field
   are in Settings > License; US storefront shows a website link under 3.1.1(a); how to test with the
   sandbox account. Re-read 3.1.1, 3.1.1(a), 3.1.3(b) before submitting (update ADR-0007's snapshot).
6. **Do not submit before production FUTOpay has M8 live with Sandbox acceptance on** (§ 7c.2
   Deploy): App Review's purchase is a Sandbox transaction against production FUTOpay, and a failed
   redemption is a 2.1 rejection with no client-side fix.

**Google Play Console**
1. Merchant account and payments profile (the Play account's payment details and tax info).
2. Create the **one-time in-app product** (`futo_notes_license`), price, activated, for `com.futo.notes`.
3. Copy the app's **Base64 RSA public key** (Monetize > Monetization setup) into the **lib-polar**
   staging and production configs (`GOOGLE__PLAY_PUBLIC_KEY_BASE64`, § 7c.5), not into the client.
4. License testers (Settings > License testing) with test cards; an internal-testing release of the
   `play` AAB (billing needs a Play-installed build).
5. No second Play app (D27): staging purchases use license testers on `com.futo.notes`'s internal
   track.
6. Enroll in Play's **15% service fee tier** if offered/required for the lower rate (the fee page
   says the 15% rate requires enrollment). Update the Data safety form and the store listing for
   purchases (listing text must not name our website for purchase).

### M7.6 Sizing, dependencies, tests, risks

| Piece | Size | Needs |
|---|---|---|
| M6 license follows the vault, one proof kind (the pair) | L (sync engine, `/slow-review`) | **deferred (D28)**; @justin OK on § 7 when picked up |
| M8 lib-polar: Apple redeem (L1-L6) + Google redeem (L7-L10), staging then production | M (other repo, its own review loop) | **start now**; gates every end-to-end test and the submission |
| M7.1 Rust: redeem workflow, `post_json` transport, FFI, routing, conformance | S-M | before shells; no M6 dependency |
| M7.2 iOS StoreKit shell + pending state | M | M7.1, App Store Connect product; M8 on staging for the real check |
| M7.3 Android `play` Billing shell + pending state | M | M7.1, Play product; M8 on staging for the real check |
| M7.4 UI/copy/spec | S | M7.2/M7.3 |
| M7.5 store setup | human, days of calendar time (agreements, review) | start now, it gates QA |

**Order.** M8 (lib-polar) and M7.5 start immediately, since both are calendar-bound. M7.1 in
parallel, then M7.2 and M7.3 together with M7.4. Real purchase QA needs M8 on staging; submission
needs M8 on production. M6 is deferred (D28) and does not gate submission. A store build before M7
keeps shipping today's key-only shape (ADR-0005).

**Tests.** Rust: `cargo test -p futo-notes-license -p futo-notes-ffi` with the redeem conformance
cases. iOS: `LicenseModelTests` with fake store and fake redeem, StoreKit config file tests.
Android: `BillingClient` and redeem fakes, the `direct`-has-no-billing Gradle check, the existing
`LicenseSurfaceTest`. lib-polar: § 7c.2 and § 7c.5 (throwaway CA, minted RSA key, one real golden
each). End to end, driven on real devices per the coverage rule: a Sandbox purchase on a TestFlight
build and a license-tester purchase on the internal track, each against staging FUTOpay, each ending
Licensed with a normal key card; Restore on a reinstall returns the same key; the revealed key
activates desktop and the other phone by paste. Cross-platform sync
(`tests/cross-platform-sync.mjs`) only when M6 is picked up: one proof kind, the pair.

**Risks.**
1. **FUTOpay is on the purchase path.** A FUTOpay outage means money taken and no key until Try
   again; Apple keeps the transaction, Play refunds an unacknowledged purchase after three days.
   App Review runs against production FUTOpay, so an outage or a wrong `APPLE__APP_APPLE_ID` during
   review is a 2.1 rejection: M7.5 step 6.
2. **M8 is in another repo with its own review cadence** and gates everything; start it first. A
   server bug is fixed in minutes with no app release, which is the upside of the same fact.
3. Fee figures for Google differ between Google's pages and summaries; D-A needs a Play Console check.
4. Sandbox and license-tester purchases are real signatures that mint **production** keys; bounded
   by our tester lists and by the Q12 containment (flag now, short-expiry v2 later). The Apple
   library's exception and payload names and Google's hash/key format are confirmed by the first real
   fixture of each (§ 7c.2, § 7c.5).
5. Google's three-day refund after a missed acknowledgement; mitigated by acknowledging only after
   the pair is stored and retrying on every connect and `onResume`.
6. 3.1.3(b) in the US (D-C) and the US commission ruling can change the table; routing is one Rust
   function for that reason.
7. Keys are bearer strings and refunded purchases keep a working key (D18, ADR-0004).
8. `play` outside a program cannot say where to buy beyond the store: acceptable, the store sheet is the Buy.
9. Privacy: the JWS (with `originalTransactionId`) or the Play receipt (with `purchaseToken`) goes to
   FUTO, once, on a tap; nothing else about the device does. State it in the privacy copy and the
   Data safety form.

## 7c. M8 — store purchases are redeemed for a FUTOpay key (ADOPTED, D29; lib-polar MR + client)

> **Deferred 2026-10-19.** lib-polar!62 and the redeem endpoints are not being built now. Nothing
> in this section is a task; it stays as the record. The paragraph below is as written on
> 2026-10-16.
>
> **Adopted 2026-10-16 (D29), after being rejected the same morning under D19.** This was the
> design; § 7b is the client and store-setup half and points here. [ADR-0008](../adr/0008-store-purchases-are-redeemed-for-a-key.md)
> records the decision. § 7c.1-7c.4 are the Apple scoping as written before the decision (the
> "if chosen" wording is now "as decided"); **§ 7c.5 adds the Google Play half**, which the
> original scoping did not cover.

The app sends the store's signed proof (StoreKit 2 signed transaction; Play signed purchase) to
**FUTOpay (lib-polar)**, which verifies it (Apple's official Python library; the Play public-key
signature) and answers with an ordinary FUTOpay license key + activation. The client then holds
**only** FUTOpay pairs, on every platform. This supersedes ADR-0007's "No server work", "three
possible proofs", "verified offline in Rust" and "never sent to FUTO" clauses and replaces the Rust
verifier half of the pre-D29 M7. Read for this section
(2026-10-16): ADR-0005/0007; this plan §§ 0, 7, 7b, 8, 9; `crates/futo-notes-license`
(`enter.rs`, `activation.rs`, `config.rs`, `AGENTS.md`); `crates/futo-notes-ffi/src/license/`;
`apps/ios/Sources/License/`; `docs/spec/license.md` (principles, entering a key); lib-polar
`main` (`licensing/key.py`, `utils/org_tools.py` `create_key_func`/`issue_session_license`,
`api/public/pages.py`, `webhooks.py`, `database/dto.py` + `db_manager.py` table registry,
`pyproject.toml`, `.gitlab-ci.yml`) and branch `feat/futo-notes-v2-activation` (read through
`git show`/`diff`, not checked out). Apple library facts are from the
[README](https://github.com/apple/app-store-server-library-python) and
[`signed_data_verifier.py`](https://github.com/apple/app-store-server-library-python/blob/main/appstoreserverlibrary/signed_data_verifier.py)
as fetched 2026-10-16 (a summarizing fetch, not a source checkout).

### 7c.1 The flow

1. User taps Buy (iOS). `product.purchase()`; on `.success` the app holds
   `VerificationResult.jwsRepresentation` and does **not** call `transaction.finish()` yet.
2. The same tap continues into one `POST {pay2}/api/v1/redeem/apple/futo-notes` with the JWS.
   This is user-initiated, so the zero-background-network principle holds (license.md
   § Principles: "only on an explicit user action"); the spec line becomes "two explicit actions:
   a bare key's `GET`, and an Apple redemption `POST`", each one request, no retry.
3. The server verifies the JWS, maps `originalTransactionId` to a license (minting one on
   first sight), and answers `200 {"license_key": ..., "activation": ...}`.
4. The app feeds that pair to the **existing** `evaluate` exactly as a typed or deep-linked
   pair (the server's answer is untrusted until the baked org key verifies it, so a hostile or
   confused server cannot make anything Licensed). Stored in `LicenseStorage` like any pair;
   then `transaction.finish()`; then the M5 landing.
5. **Restore Purchases** = `AppStore.sync()`, read `Transaction.currentEntitlements`, redeem
   the license product's JWS the same way. Idempotent on `originalTransactionId`: same key
   back, no second mint. Works on any device signed into the buyer's Apple ID.
6. The card already has tap-to-reveal for the key, so an iOS buyer can type the key on Android or
   desktop (one `GET`, existing path) without sync; with M6 it just appears.

**Offline / failure at purchase time.** The StoreKit purchase itself needs the network, so the
window is "App Store reachable, FUTOpay not" (outage, captive portal, 5xx). The unfinished
transaction stays in StoreKit's queue, and the shell also keeps the JWS in a pending slot in
`LicenseStorage` (a string awaiting redemption, never evaluated, never shown as Licensed: D8
means the shell does not trust StoreKit's `.verified`). The License card shows a fourth state,
"Purchase received, not yet activated", with **Try again** and **Restore Purchases**, both
user-initiated. No launch-time or Settings-visit auto-retry (that would be a background network
call); whether the card may retry once when the user opens it is a question for @justin (§ 9).
Cost of this design versus ADR-0007: between a paid purchase and a successful redemption the
user is not Licensed, where the offline proof would be Licensed instantly. Apple keeps the
transaction, so nothing is lost, only delayed; support can point to Restore.
Server answers map as: 200 verified; transport error or 5xx = pending; 4xx (bad JWS, wrong
bundle/product/environment) = "couldn't verify this purchase, contact support" (new copy), nothing
stored.

### 7c.2 lib-polar (read-only study; nothing there was changed)

**How keys are minted today.** A Polar `order.paid` webhook (`api/public/webhooks.py`,
`POST /webhook/polar/{org_slug}`) or the buyer's status poll both funnel into
`issue_session_license` (`utils/org_tools.py`), serialized by `app_session_issue_lock`, which
confirms the purchase with Polar and calls `create_key_func`. `create_key_func(db, org_slug,
product_slug, customer_email)` is the reusable core and is already what the admin route
`/admin/createkey/{org}/{product}` calls: it generates a key + activation with the org's RSA
key, inserts a `used_license_keys` row (public schema) and a `license_activations` row (org
schema, keyed by `license_key`). `GET /api/v1/activate/{key}` then serves the stored
activation (`api/public/pages.py`). Data model: `organizations` (signing key pair),
`futopay_products` (per org; already has an unused-for-this `apple_store_url`),
`used_license_keys`, `license_activations`, `app_sessions`. Tables and missing columns are
created at startup from the model lists (`_PUBLIC_TABLES` / `_ORGANIZATION_TABLES` in
`db_manager.py`), so a new table needs no migration script.

**New endpoint.** `POST /api/v1/redeem/apple/{org_slug}`, body `{"signed_transaction": "<jws>"}`,
in a new `api/public/apple.py` bound from `bind_public_api` (`api/public/__init__.py`). Steps:
verify, check the product mapping, then under a lock (or an `INSERT ... ON CONFLICT DO
NOTHING` on the primary key, then re-read) look up `original_transaction_id`; if absent call
`create_key_func(db, org, product, customer_email="apple:<originalTransactionId>")`, store the
mapping, and return the key plus the activation the activation table holds. Idempotent and
race-safe because the mapping row is the single source; two concurrent first redemptions must
yield one key, mirroring `app_session_issue_lock`.

**Storage.** New public table `apple_transactions`: `original_transaction_id` PRIMARY KEY,
`license_key`, `org_slug`, `product_id`, `apple_product_id`, `bundle_id`, `environment`
(`Production`/`Sandbox`), `first_transaction_id`, `t_created`, `t_last_redeemed`,
`redeem_count`. Add a `DatabaseManager` getter/insert next to `get_used_license_key`.

**Verification with Apple's library** (`pip install app-store-server-library`, Python 3.8+;
this server is 3.12). API as read 2026-10-16:
`SignedDataVerifier(root_certificates: List[bytes], enable_online_checks: bool, environment,
bundle_id, app_apple_id=None)`, then `verify_and_decode_signed_transaction(signed_transaction)
-> JWSTransactionDecodedPayload`; failures raise `VerificationException` carrying a
`VerificationStatus` (`INVALID_APP_IDENTIFIER`, `INVALID_ENVIRONMENT`, `INVALID_CHAIN`,
`INVALID_CERTIFICATE`, `INVALID_CHAIN_LENGTH`, `VERIFICATION_FAILURE`,
`RETRYABLE_VERIFICATION_FAILURE`). In that method the library checks `bundleId` and
`environment` equality; it does **not** check `app_apple_id` there, but the constructor requires
`app_apple_id` when `environment == PRODUCTION`. Consequences for us:

- **Roots**: all three Apple roots (Apple Root CA, G2, G3; decided, § 9 Q8) as DER files in the
  repo (README: download from Apple PKI, "provide these certificates as an array"). The
  root-to-trust question is closed; the chain, role and date rules are the library's, not ours.
- **A verifier is per environment**: build one for Production (needs the numeric App Store app
  id) and one for Sandbox, and try Production then Sandbox, or read the unverified `environment`
  claim only to choose which verifier to try, never to skip verification.
- **Never construct a verifier for `XCODE` or `LOCAL_TESTING`**: for those the library returns
  the payload **without checking the signature** (its `_decode_signed_object` skips verification
  and leaves the environment check to the caller). Only `PRODUCTION` and `SANDBOX` are ever
  configured, and a test asserts it.
- **`enable_online_checks`**: `True` makes the library call Apple's OCSP responder per
  verification (30 s timeout, `RETRYABLE_VERIFICATION_FAILURE` on network trouble) and use the
  current date for certificate validity; `False` validates against the transaction's signed
  date and makes no outbound call. Refunds are out of scope (@justin 2026-10-16), so recommend
  `False`: no new availability dependency on Apple's OCSP host. Not revisited unless refunds return.
- **Claims we check ourselves** after the library: `productId` equals the configured Apple
  product id, `type` is non-consumable, `inAppOwnershipType == PURCHASED` (reject family-shared),
  and bundle id as configured. `revocationDate` is ignored (refunds are not a concern); it can
  be turned into a 4xx later with one line.
- **App Store Server API keys are not needed.** We verify a JWS Apple already signed; no call to
  Apple's API. Keys (and a JWT signer) would only be needed to fetch transaction history,
  look up a refund, or send test notifications, all out of scope.

**Config / secrets.** No new secret. Non-secret config: `APPLE__BUNDLE_ID` (`com.futo.notes`),
`APPLE__APP_APPLE_ID` (numeric, from App Store Connect), `APPLE__ROOT_CERT_DIR`,
`APPLE__ACCEPT_SANDBOX`, and a per-product map from the Apple product id to the FUTOpay
org/product slug in the same `.env` style the v2 branch uses
(`POLAR__ORGS__FUTO_NOTES__PRODUCTS__FUTO_NOTES__APPLE_PRODUCT_ID`). The org signing key is the
existing one (no new key; the memory note on org keys applies: the deployed key, not 1Password,
is the authority).

**Staging vs production.** The deployments split exactly as today (`staging-pay2` mints with the
staging org key, `pay2` with the production key), and the client's `Environment` already picks
host + key together (no dev/prod crossover). Two facts shape this:

1. A `.dev` bundle has no App Store Connect record, so it can only buy through an Xcode StoreKit
   configuration, whose transactions are `XCODE`-environment and **unverifiable by the server by
   design**. So `.dev` builds cannot exercise the real endpoint end to end. Real Sandbox
   purchases come from a **TestFlight build of `com.futo.notes`**, and TestFlight/App Review
   purchases are Sandbox transactions in the *release* binary, which talks to **production**
   FUTOpay. So the production deployment must accept Sandbox transactions (this is the server
   half of Q7), or the reviewer's purchase fails.
2. The staging path remains testable through the existing `FUTO_LICENSE_ENV=staging` compile
   flag on a TestFlight build of the release bundle: staging FUTOpay is configured with the
   release bundle id and accepts Sandbox only.

**Sandbox abuse, and the recommended containment.** A Sandbox JWS is a real Apple signature, and
TestFlight purchases are free, so on a production server that accepts Sandbox, anyone who can
install our TestFlight build can mint production keys. The stakes are a cosmetic (and ADR-0004
already accepts reuse), but it is unbounded. Options: (a) accept it, flag the row
`environment=Sandbox` so keys can be audited; (b) mint Sandbox redemptions as **v2 activations
with a short `expires_at`** (needs the v2 branch; the client already verifies v2 and shows
Expired); (c) refuse Sandbox in production and give the reviewer a review-only build (a second
binary: rejected by Q7 as written). Recommendation: (b) if v2 lands first, else (a).

**Is the v2 branch a prerequisite? No.** `create_key_func` on `main` mints v1, which the client
accepts today. The branch (`feat/futo-notes-v2-activation`, last commit 2026-09-09, 63 commits
behind `main`, merge-base `fac91ab0`) adds per-product `activation_format`/`license_term_months`
and `issue_activation`. It helps (a real `issued_at` for the card, the product bound into the
signature, short-expiry Sandbox keys) and it hardens the v1 tripwire (`crates/futo-notes-license/
AGENTS.md`), but redemption through v1 is correct. If both are wanted, land v2 first: the
redeem endpoint then calls the same `mint_license_key_pair` the branch introduces. Verified by
reading the diff only; I did not run either branch.

**Rate limiting / abuse.** lib-polar has no rate-limit machinery (grep for slowapi / rate-limit
finds only an unused `RateLimitError` class). Verification is a local ECDSA + chain check with
`enable_online_checks=False`, so garbage bodies are cheap to reject; a mint needs a valid Apple
signature and happens once per `originalTransactionId`. A JWS is a bearer proof: replay returns
the same key, exactly ADR-0004's stance. Add a body-size cap and a per-IP limit at the reverse
proxy rather than in the app (not verified what fronts pay2; ask the lib-polar owner).

**Tests (lib-polar).** No Apple dependency in CI: tests mint a throwaway CA, leaf and ES256 JWS
and pass the throwaway CA as the verifier's `root_certificates` (the library takes whatever
roots it is given). Cases: valid mint, replay returns the same key, concurrent first
redemptions yield one row, wrong bundle, wrong product, wrong environment, family-shared,
tampered payload, chain to an unknown root, `alg` not ES256, Xcode-environment payload rejected
(proves we never configure it), Sandbox refused when `ACCEPT_SANDBOX` is off. One golden from a
real TestFlight transaction (captured once, checked in with its date; its leaf will have expired
so the test pins the effective date by running with online checks off, as production does).
Existing test style: plain `test_*.py` under `pylib/futopay_server/tests/`, runnable without a
database for the pure-function ones (see `test_activation_v2.py` on the branch).

**Deploy.** The table is created on next startup; add the dependency to `pyproject.toml` and the
`server.Dockerfile` image; set the `.env` variables on staging and production; ship the Apple
root files with the image. **Hard ordering**: production FUTOpay must be live with the endpoint
and Sandbox acceptance **before** an App Store submission, because App Review exercises it.

#### lib-polar task list

| # | Task | Size | Files |
|---|---|---|---|
| L1 | Dependency + Apple roots + config (`APPLE__*`, product map), `AppleVerifier` wrapper: per-environment verifiers, claim checks, never XCODE/LOCAL_TESTING, mapped exceptions | S-M | `pyproject.toml`, `server.Dockerfile`, new `licensing/apple.py`, new `licensing/apple_roots/*.cer`, `common.py` (config), `env.example` |
| L2 | `apple_transactions` table + manager getter/insert, race-safe first-redeem | S-M | `database/dto.py`, `database/db_manager.py` (`_PUBLIC_TABLES`) |
| L3 | `POST /api/v1/redeem/apple/{org}` route: verify, map, mint via `create_key_func` (or v2 `mint_license_key_pair`), idempotent, JSON response, error codes (200/400/403/404/409/503) | M | new `api/public/apple.py`, `api/public/__init__.py`, reuse `utils/org_tools.py` |
| L4 | Tests with a throwaway CA (+ one real golden) | M | `tests/test_apple_redeem.py`, `tests/conformance/` |
| L5 | Sandbox policy: acceptance flag, row flag, optional short-expiry v2 | S (L if v2 not yet landed) | `api/public/apple.py`, branch `feat/futo-notes-v2-activation` |
| L6 | Deploy: staging then production, App Store Connect ids, proxy limit, README section | S | `README.md`, deployment repo (not read) |

Whole lib-polar side: **M** (about a week of focused work including tests; L5's v2 dependency is
the only thing that could widen it).

### 7c.3 FUTO Notes (this repo)

**Rust (`crates/futo-notes-license`, `crates/futo-notes-ffi`).** No JWS verifier, no Apple roots,
no `LicenseProof` enum, no `evaluate` change. What is left:

- `redeem_apple(jws, config, transport) -> Result<AcceptedLicense, EnterKeyError-like>` next to
  `enter_license_key`: POST the JWS, parse `{license_key, activation}`, then `evaluate` the
  pair like any other (the same `LicensePair`, the same product and key-prefix checks). Reuses
  `AcceptedLicense`. `redeem_url(config)` joins the existing `activation_url` in `config.rs`
  (same environment-selected host).
- The transport trait is GET-only today (`ActivationTransport::get`); add `post_json` (or a
  sibling trait) and `Pay2Transport::post_json` in `futo-notes-ffi/src/license/transport.rs`
  (same timeouts, no redirects, no retry). The "exactly one GET" rule in
  `crates/futo-notes-license/AGENTS.md` and license.md becomes "at most one request per
  explicit action".
- FFI: `license_redeem_apple(jws, bundle_id)` in `contract.rs` mirroring `license_enter_key`;
  Tauri gets nothing (desktop never purchases).
- Conformance: extend `tests/conformance/license.json` with redeem cases (200 with a signed pair,
  200 with a bad signature, 404/4xx, 5xx, transport failure, wrong product) and the
  "panics on any request" transports stay for the offline paths.

**iOS (`apps/ios/Sources/License/`).** `LicenseStoreKit` (load product, Buy, Restore,
`Transaction.updates` observed only to *deliver* unfinished transactions into the pending slot,
never to call the network); `LicenseStorage` gains the pending-JWS slot; `LicenseModel` gains a
`pendingRedemption` state and the redeem action; `LicenseSettingsSection` the fourth card state
+ Try again + Restore; the picker's key-only sheet becomes Buy + "I already paid"
(`LicenseCopy`: new strings for the pending and not-verified states, catalog entries, English
only). No refund handling (nothing observes `revocationDate`). Tests: `LicenseModelTests` with a
fake store and fake redeem (success, cancel, `.pending`, transport failure leaves the pending
slot and keeps the transaction unfinished, retry succeeds, restore returns the same key, 4xx
stores nothing); a StoreKit configuration file for UI tests, where the redeem call is faked
because the server cannot verify `XCODE` transactions. A sandbox purchase through a TestFlight
build against staging FUTOpay is the real end-to-end check (needs L1-L5 deployed to staging).

**M6 gets smaller.** It only ever carries a FUTOpay pair (`{key, activation}`): no tagged union,
no "prefer the FUTOpay pair" ranking, no Apple verification on Android and desktop, no
refund/revocation tombstone rule (§ 9 Q9 shrinks to the offline-Remove rule § 7 already needs),
and an iOS purchase reaches Android/desktop as a plain pair or a typed key. § 7's remaining
costs (engine slot, LWW rule, `/slow-review`) are unchanged.

**Specs/ADR.** ADR-0007 gains a "superseded in part by 7c" note if chosen; license.md
principles (network wording, "never sent to FUTO"), § Store posture, a Restore section; plan
D15 text.

#### FUTO Notes task list

| # | Task | Size | Files |
|---|---|---|---|
| A1 | Rust redeem workflow + `redeem_url` + POST transport + FFI export + conformance cases | M | `crates/futo-notes-license/src/{enter,config,lib}.rs` (or new `redeem.rs`), `crates/futo-notes-ffi/src/license/{contract,transport,mod}.rs`, `tests/conformance/license.json`, `scripts/gen-license-fixture.mjs` |
| A2 | iOS StoreKit layer: Buy, Restore, pending slot, finish-after-activate | M | new `LicenseStoreKit.swift`, `LicenseStorage.swift`, `LicenseModel.swift` |
| A3 | iOS UI: pending/not-verified card state, Try again, Restore, Buy in the picker sheet, copy + catalog | S-M | `LicenseSettingsSection.swift`, `LicenseCopy.swift`, `AppIconPicker.swift`, `languages/en.json` |
| A4 | iOS tests (fake store/redeem), StoreKit config file, TestFlight-vs-staging QA pass | M | `apps/ios/Tests/...`, `*.storekit` |
| A5 | M6 simplified to one proof kind (already its own MR) | L (as before, minus the Apple branch) | `crates/futo-notes-sync/...` |
| A6 | Spec + ADR + plan edits; App Store Connect checklist (§ 7b, unchanged) | S | `docs/spec/license.md`, `docs/adr/0007-*.md`, this plan |

FUTO Notes side: **M** for A1-A4 (the large risk item, the offline JWS verifier, is gone), A5 as before.

### 7c.4 Comparison with ADR-0007 (offline proof)

| | ADR-0007: offline Apple JWS in Rust | 7c: redeem for a FUTOpay key |
|---|---|---|
| lib-polar | none | M (L1-L6) |
| FUTO Notes Rust | verifier + roots + chain/role/date rules + new proof type through `evaluate`/FFI/Tauri + test CA + real golden: L, highest risk | redeem workflow + POST transport: M |
| iOS shell | StoreKit + Restore + `Transaction.updates` revocation removal | StoreKit + Restore + pending state |
| Android / desktop | verify a synced Apple JWS (needs M6 or nothing) | a real key, typed in with one request, or via M6; works without sync |
| M6 | two proofs, ranking, tombstone-for-refund | one proof kind |
| Licensed after purchase | instantly, offline | after one FUTOpay round trip (pending state if it fails) |
| FUTOpay availability | irrelevant | a hard dependency at purchase and at Restore, and **during App Review** |
| Sandbox (Q7) | client rule needing `AppTransaction.environment` | server flag; TestFlight/review hit production FUTOpay |
| Apple roots / chain rules (Q8) | ours to get right and keep current | Apple's library's |
| Display (Q10) | no key, no `issued_at` | a normal key card |
| Privacy | JWS never leaves the device | JWS (with `originalTransactionId`) goes to FUTO |
| Account binding | proof bound to Apple ID, portable only via the vault | key is bearer and portable; Apple ID only needed to Restore |

Open questions that disappear: Q8 (roots, validation time: the library), Q10 (display), the
tagged-proof part of M6, Q7's client-side `AppTransaction` input. Q9 shrinks. New ones: the
Sandbox containment above, whether the card may retry on open, the proxy rate limit, and the
prod-deploy ordering before submission.

Risks of 7c worth naming: (1) money taken but no key when FUTOpay is down, softened by
Apple's durable transaction and Restore, but a support burden; (2) App Review runs against
production FUTOpay, so an outage or a mis-set Apple app id is a rejection (guideline 2.1) with
no client-side fix; (3) a server bug is fixed in minutes, a verifier bug in the shipped app
needs a release; (4) FUTOpay being ever retired strands Restore (existing keys keep verifying
offline); (5) the Sandbox-mints-production-keys exposure.

**Recommendation, taken as D29.** Take 7c. It deletes the riskiest, least-verified piece of ADR-0007 (a
hand-written Rust copy of Apple's `ChainVerifier`, which ADR-0007 itself says nobody has read),
reuses the one mint path and the one client rule that already ship, and gives Android and
desktop a real key. Its price is a hard FUTOpay dependency at purchase and review time and a
privacy reversal (the JWS goes to FUTO), both of which are bounded and operable. Order: L1-L3
and L4 on staging first, then A1-A2 against a TestFlight build with `FUTO_LICENSE_ENV=staging`,
then production deploy, then submit. Land v2 first only if the short-expiry Sandbox containment
is wanted; it is not required for correctness.

Not verified: the Apple library was read through a summarizing fetch of its README and
`signed_data_verifier.py`, not a checkout, so exact exception class names and the
`JWSTransactionDecodedPayload` field names should be confirmed against the installed version;
Apple's own JWSTransaction/`jwsRepresentation` doc pages returned 404 to the fetch tool; that
TestFlight purchases are Sandbox-environment is from general knowledge (ADR-0007 states it the
same way); what fronts pay2 (rate limit), the deployment repo's env handling, and whether a
Sandbox `originalTransactionId` is reused across tester resets were not checked; no code was
run in either repo.

### 7c.5 Google Play redemption (added with D29, 2026-10-16)

The Apple scoping above generalizes to Play with a simpler verifier and one different identity.
Sources are the ones ADR-0007's Google section lists (read 2026-10-16); nothing here was run.

**Endpoint.** `POST /api/v1/redeem/google/{org_slug}`, body
`{"original_json": "<Purchase.getOriginalJson()>", "signature": "<Purchase.getSignature()>"}`,
in the same new module as the Apple route (or `api/public/google.py`), bound from
`bind_public_api`. Answer shape and status codes identical to Apple's.

**Verification.** Two options; **(a) is the v1 choice**, (b) the upgrade path.

- **(a) Signature only, no Google call.** Verify the Base64 `signature` over the exact UTF-8 bytes
  of `original_json` with RSASSA-PKCS1-v1_5 and the app's Play public key
  (`GOOGLE__PLAY_PUBLIC_KEY_BASE64`, the Base64 X.509 SubjectPublicKeyInfo from Play Console >
  Monetize > Monetization setup), using the RSA library lib-polar already signs org keys with.
  Hash: SHA-1 per Google's long-standing sample (`SHA1withRSA`); the fetched pages do not state it,
  so the **first task is to confirm hash and key format against a real license-tester purchase**
  (the real golden below). Only after the signature verifies, parse the JSON and check
  `packageName == GOOGLE__PACKAGE_NAME` (`com.futo.notes`), `productId` (or the single
  `productIds` entry) maps to a FUTOpay product, `purchaseState == 0` (PURCHASED; 1 canceled and
  2 pending are rejected with a 4xx), `quantity` absent or 1. Same posture as Apple with
  `enable_online_checks=False`: no outbound call, no new secret, no availability dependency on
  Google.
- **(b) Google Play Developer API** (`purchases.products.get` with a service account linked in Play
  Console): confirms the purchase against Google's records, exposes `purchaseType == 0` (a
  license-tester purchase, which the client JSON never marks), detects voided purchases, and
  would allow server-side acknowledgement. Costs a service-account secret, API enablement, a
  Google client dependency and an outbound call on the purchase path. Not built for v1; it is the
  containment to reach for if tester-minted production keys ever matter (the Google twin of Q12).

**Identity and idempotency.** The key is `purchaseToken` (unique per purchase, present on test
purchases; `orderId` is **absent** on license-tester purchases, so it cannot be the key). Table
`google_purchases`: `purchase_token` PRIMARY KEY, `license_key`, `org_slug`, `product_id`,
`play_product_id`, `package_name`, `order_id` (nullable), `purchase_time`, `t_created`,
`t_last_redeemed`, `redeem_count`; registered in `_PUBLIC_TABLES` like `apple_transactions`.
First sight mints through the same `create_key_func` (`customer_email="google:<sha256(purchaseToken), hex>"`,
the token itself is a bearer secret and is not stored in that column); replay returns the same
pair; two concurrent first redemptions yield one row (same lock or `ON CONFLICT` pattern as Apple).

**Acknowledgement stays client-side** (§ 7b M7.3): the server never acknowledges (that needs (b)),
and Google's three-day auto-refund of an unacknowledged purchase is the correct outcome for a
purchase that was never redeemed.

**Staging vs production.** There is no second Play app (D27), so **both** FUTOpay deployments
configure the same `com.futo.notes` public key and package name, and which server a tester
purchase reaches is decided by the build's `FUTO_LICENSE_ENV`. A license-tester purchase on the
internal track is signed like a real one and mints a key wherever it is redeemed; against
production that is a production key. Containment is the tester list in Play Console, plus (b)
later if wanted. Debug builds and automated tests use a fake `BillingClient` and a fake redeem;
they never reach the endpoint.

**Config.** Non-secret: `GOOGLE__PACKAGE_NAME`, `GOOGLE__PLAY_PUBLIC_KEY_BASE64`, and a per-product
map from the Play product id to the FUTOpay org/product slug in the same `.env` style as the Apple
map. No new secret for (a).

**Tests (lib-polar).** A minted test RSA key pair and a helper that signs JSON: valid mint; replay
returns the same key; concurrent first redemptions yield one row; wrong package; wrong product;
pending (2); canceled (1); tampered JSON; signature from another key; wrong key format; quantity 2;
missing `orderId` still mints. One real golden from a license-tester purchase on the internal
track (no expiry, so it never rots); it is what proves the hash and key-format claim.

#### lib-polar task list (Google half; continues the Apple L1-L6)

| # | Task | Size | Files |
|---|---|---|---|
| L7 | Config (`GOOGLE__*`, product map) + `GoogleVerifier` (RSA PKCS1 v1.5 over `original_json`, claim checks) | S | `common.py` (config), new `licensing/google.py`, `env.example` |
| L8 | `google_purchases` table + manager getter/insert, race-safe first-redeem | S | `database/dto.py`, `database/db_manager.py` |
| L9 | `POST /api/v1/redeem/google/{org}` route, same answer shape and codes as Apple | S-M | `api/public/google.py` (or shared `redeem.py`), `api/public/__init__.py` |
| L10 | Tests with a minted key (+ one real golden) | S-M | `tests/test_google_redeem.py` |

Whole lib-polar side, Apple + Google: **M** (L1-L10), **one MR** (D32); the Apple half is
the larger. Deploy ordering as § 7c.2: staging first (every end-to-end test needs it), production
before any store submission.

#### Client task list under D29 (replaces the pre-D29 M7.1 verifier work; § 7b has the detail)

| # | Task | Size | Files |
|---|---|---|---|
| A1 | Rust redeem workflow for both receipts + `redeem_url` + `post_json` transport + FFI exports + conformance cases | S-M | `crates/futo-notes-license/src/{enter,config,lib}.rs` (or new `redeem.rs`), `crates/futo-notes-ffi/src/license/{contract,transport,mod}.rs`, `tests/conformance/license.json`, `scripts/gen-license-fixture.mjs` |
| A2 | iOS StoreKit layer: Buy, Restore, pending slot, finish-after-pair | M | new `LicenseStoreKit.swift`, `LicenseStorage.swift`, `LicenseModel.swift` |
| A3 | Android `play` Billing layer: Buy, Restore, pending slot, acknowledge-after-pair, flavor split + Gradle check | M | `app/src/play/.../PlayLicenseStore.kt`, `app/src/direct/.../NoLicenseStore.kt`, `LicenseModel.kt`, `app/build.gradle.kts` |
| A4 | UI + copy on both shells: pending state, Try again, Restore, Buy in the picker sheet, catalog | S-M | `LicenseSettingsSection.swift`, `LicenseCopy.swift`, `AppIconPicker.swift`, the Android equivalents, `languages/en.json` |
| A5 | Tests: fake store + fake redeem on both shells, StoreKit config file, TestFlight / internal-track QA against staging | M | `apps/ios/Tests/...`, `apps/android/.../test`, `*.storekit` |
| A6 | Spec + ADR + plan edits; the `AGENTS.md` network rule; store checklist (§ 7b M7.5) | S | `docs/spec/license.md`, `crates/futo-notes-license/AGENTS.md`, this plan |
| A7 | M6 simplified to one proof kind (deferred, D28; own MR when picked up) | L | `crates/futo-notes-sync/...` |

## 8. Order and sizing

Order since 2026-10-19: **W1, W2, release.** The names are the work items in
[`license-master-plan.md`](license-master-plan.md).

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

## 9. Open questions for @justin

One reconciled set (2026-10-16). Earlier per-pass notes were merged here.

**Deferred 2026-10-19 (@justin).** D15–D32 and everything built on them (store purchases,
redemption, the lib-polar MR, the key-only copy retiring). Nothing below under those decisions is
open or scheduled; the "Decided" and "Open" items that refer to them are the record. Separately,
the key-only wording is under review.

**Decided.**
- Picker treatment A (D11). iOS Expired -> Renew accepted on unit coverage. M6 waits for its own MR (deferred, D28).
- Q1 Expired closes the picker; Q2 the toast is enough on desktop; Q4 the row hint shows everywhere;
  Q5 the card paragraph is the sketch wording (`license.explanation`). Taken as written, reopen if wrong.
- **Refunds out of scope** (D18; Q9 reduces to "a Remove tombstone wins over an offline device").
- **Buy everywhere** (D17), **US iOS -> website** (D21, Q6).
- **D29, store purchases are redeemed for a FUTOpay key, 2026-10-16:** § 7c adopted for both
  stores (ADR-0008); supersedes D19 "no server work", D20 (Sandbox moves server-side), D22 (Google
  offline) and D26 (the card is the normal key card). The client never verifies a store proof. Q8
  below is moot in this repo (the Apple library owns roots and chain rules).
- **D28, punt on license sync (M6), 2026-10-16:** M6 is deferred, not cancelled; M7 ships without it; D16 is superseded. Q3 below stays decided for when M6 is picked up.
- **Q3, M6 carrier: the hidden engine slot**, a reserved path kept in engine state, never a file in
  the notes folder; any valid proof counts, duplicates keep one, a Remove tombstone beats an offline
  device (@justin 2026-10-16; § 7 Feasibility option (a)).
- **Q8, Apple roots: all three** (Apple Root CA, G2, G3), under D29 as DER files in lib-polar (§ 7c.2) rather than in the binary, with the Apple
  library's chain rules (three certificates; leaf OID `1.2.840.113635.100.6.11.1`, intermediate
  `1.2.840.113635.100.6.2.1`, re-confirm against a checkout; validity at the signed date).
  Tests inject the Xcode StoreKit anchor in test code only; a test asserts the release anchor set
  is exactly Apple's roots.

**Open, for @justin (recommendations in § 7b M7.0).**
- D-A, D-B, D-C and Q10: **resolved 2026-10-16** as D23–D26 (D26 since superseded by D29).
- Q11: **resolved 2026-10-16** as D27 (no second Play app).
- Q12 (Sandbox containment), Q13 (retry on open) and Q14 (one lib-polar MR or two): **resolved
  2026-10-16** as D30, D31, D32. Nothing is open.

Unverified, to settle by a real fixture or a Play Console look: the Google signature hash (SHA-1 per
the long-standing sample) and key format, Google's current fee figures, the Apple library's exact
exception and payload names (§ 7c.2 read it through a summarizing fetch), and whether a Sandbox
`originalTransactionId` survives a tester reset.

## 10. Sketches

| File | Shows |
|---|---|
| `license-cosmetics/01-settings-row-hint.png` | Settings, unlicensed, link-out build: the row hint, the only Settings-level change |
| `license-cosmetics/02-picker-unlicensed.png` | The picker unlicensed: A (chosen) beside B (rejected) |
| `license-cosmetics/03-tap-sheet.png` | The sheet on tapping a coined tile, link-out and key-only builds |
| `license-cosmetics/04-after-activation.png` | The landing right after activation, and the licensed picker on any later visit |
| `license-cosmetics/05-android-and-second-device.png` | Android's bottom sheet, and a second synced device (a picture of M6, which D28 defers) |
