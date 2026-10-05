# Plan: make the license purchase follow Apple's and Google's rules

Status: M1–M5 implemented and verified 2026-09-24; M6 production purchases and M7 store submission remain.
Decision record: [ADR-0005](../adr/0005-license-purchase-follows-store-rules.md).
Behavioral truth: `docs/spec/license.md` § Store posture (the 2026-09-24 decision).
Builds: **no new ones.** One iOS binary, the two existing Android flavors, desktop unchanged.

Written for an implementing agent. Read root `AGENTS.md`, `apps/ios/AGENTS.md`,
`apps/android/AGENTS.md`, `crates/futo-notes-license/AGENTS.md` and `docs/spec/AGENTS.md`
before touching their layers. Every milestone ends with its verification and a commit in
`type(scope): imperative summary` form with a `Verified:` line.

## 0. Decisions (locked — do not reopen without @justin)

| # | Decision | Value |
|---|---|---|
| D1 | iOS, US storefront | Full surface: Buy/Renew, "I already paid", Lost-your-key, deep link. Buy opens the **default browser** (today's `openURL`), never `SFSafariViewController` or a WebView. |
| D2 | iOS, every other storefront | **Option A**: key field and deep link only. No Buy, Renew or Lost-your-key, and no copy that asks for payment or names a website. EU and Japan are not special-cased (no External Purchase Link Entitlement). |
| D3 | iOS gate | Runtime, from StoreKit `Storefront.current?.countryCode == "USA"`, re-evaluated on `Storefront.updates`. `nil` / error → **not US** (fail closed: no link). |
| D4 | Android `direct` | Full surface worldwide; Buy/Renew open in a **Custom Tab** (plain `ACTION_VIEW` when no provider). |
| D5 | Android `play` | Key field and deep link only, worldwide: `LICENSE_LINK_OUT = false`. No External Content Links enrollment. |
| D6 | Desktop | Unchanged. |
| D7 | Rejection fallback | If Apple rejects the key field outside the US under 3.1.1: option B, a non-consumable IAP at the same price. Not built by this plan. |

## 1. Where things stand (2026-09-24)

- `license_row_actions(status, link_out)` in `crates/futo-notes-ffi/src/license/contract.rs`
  already produces the key-only shape for `link_out = false` (Unlicensed/Expired → `EnterKey`
  only; Licensed → `Remove`). Pinned by `link_out_false_hides_every_way_out_of_the_app_and_nothing_else`.
- **iOS**: `link_out` is `LicenseLinkOut.isEnabled`, a compile-time constant
  (`apps/ios/Sources/License/LicenseLinkOut.swift`, `#if LICENSE_LINK_OUT_DISABLED`). The binary
  links no StoreKit. Buy opens with SwiftUI `openURL` (`LicenseSettingsSection.swift` `open(_:)`).
- **Android**: `BuildConfig.LICENSE_LINK_OUT` is `true` on both flavors
  (`apps/android/app/build.gradle.kts`). Buy opens with an `ACTION_VIEW` intent
  (`ui/LicenseSettingsSection.kt` `open`). `LicenseLinkOutTest` fails any flavor whose constant
  is false. `androidx.browser` is already a dependency, used by
  `sync/hosted/CustomTabsAuthSheet.kt`.
- **Copy is not key-only-safe.** With `link_out = false` the Unlicensed plate still shows the
  headline `license.unlicensedHeadline` ("Pay for FUTO Notes") and `license.explanation` ("…FUTO
  Notes asks you to pay for it…"). Outside the US that is a call to action to pay outside IAP.
  Hiding the buttons is not enough.
- **Android deep-link return is untested with a Custom Tab.** `MainActivity` is `singleTop`, and
  the manifest comment says it "is always the top of the task". A Custom Tab launches into the
  app's task *above* `MainActivity`, so a `futonotes://` link fired from the tab may create a
  **second** `MainActivity` (a second `NotesStore` over the same vault) instead of reaching
  `onNewIntent`.
- A real production purchase was driven end to end on the iOS simulator on 2026-09-24
  (Release build, coupon `TESTINPROD`), so the checkout itself is known-good.

## 2. Milestones

### M1 — Rust: one owner for "may this build link out here"

- Add `license_link_out(platform, storefront_country: Option<String>, build_allows: bool) -> bool`
  to `crates/futo-notes-ffi/src/license/contract.rs`, exported over UniFFI.
  - `ios`: `build_allows && storefront_country == Some("USA")` (ISO 3166-1 alpha-3, the form
    StoreKit returns). Case-sensitive; anything else, including `None`, is `false`.
  - `android`: `build_allows` (the flavor constant); the country argument is ignored.
  - `desktop`: `true`.
- Tests beside `link_out_false_hides_every_way_out_of_the_app_and_nothing_else`: US → true,
  `"FRA"`, `"JPN"`, `""`, `None` → false on iOS; Android follows the flag alone.
- Add the table to `tests/conformance/license.json` so both shells' tests read the same cases.

Verify: `cargo test -p futo-notes-ffi license`, conformance tests green. Rebuild bindings
(`scripts/build-rust-ios.sh`, `scripts/build-rust-android.sh`).

### M2 — Copy: a key-only plate that asks for nothing

- Catalog (`languages/en.json`, `messages.license`): add `license.keyOnlyExplanation`.
  Proposed English: **"Have a FUTO Notes license? Enter your key to activate it on this device."**
  (@justin to confirm wording, §4 Q1).
- Key-only rule, on both native shells, driven by the same `link_out` value as the buttons:
  Unlicensed and Expired show **no headline** and `license.keyOnlyExplanation` instead of
  `license.explanation`. Licensed is unchanged ("Thank you for purchasing FUTO Notes." thanks,
  it does not ask).
  - iOS: `licensePlateShape(_:)` gains a `linkOut` parameter; `headline` is
    `!stored && linkOut`. `stateBody` picks the paragraph from the same value.
  - Android: the matching branch at `LicenseSettingsSection.kt` (the `unlicensedHeadline` use).
- `pnpm run check:languages`.

Verify: unit tests for the shape on both shells (`LicenseSurfaceTests`, the Android unit
equivalent), both values of `linkOut`.

### M3 — iOS: storefront gate

- New `@MainActor final class LicenseStorefront: ObservableObject` (in
  `apps/ios/Sources/License/`, replacing `LicenseLinkOut.swift`): `@Published var linkOut = false`,
  filled at launch from `await Storefront.current` and updated from `for await … in
  Storefront.updates`, each time through `licenseLinkOut(platform: .ios, storefrontCountry:,
  buildAllows: true)`. Starts `false` so nothing links out before the answer arrives (M1: the
  shell never waits on I/O to paint).
- Wire it where `LicenseModel` is created in `FutoNotesApp.swift` and pass `linkOut` into
  `LicenseSettingsSection` (it already takes a `linkOut` parameter).
- Retire `LICENSE_LINK_OUT_DISABLED` and its `project.yml` comment. Nothing needs a force-off
  once the storefront decides.
- **Debug-only override** for QA: a launch argument `-FUTOLicenseStorefront <USA|FRA|none>`,
  compiled only under `FUTO_DEBUG_BUILD`, so the simulator can drive both shapes without an
  App Store account. A Release build must not read it.
- Tests: the override is absent in Release (compile-condition test), and the class maps
  `nil` → `false`.

Verify on the simulator (`just qa-claim ios`):
1. Debug, `-FUTOLicenseStorefront USA` → Buy present, opens Safari.
2. Debug, `FRA` and `none` → no Buy, Renew or Lost-your-key; key-only copy; "I already paid"
   still activates a staging key; the `futonotes://` deep link still activates.
3. Release follows the actual `Storefront.current` result. The claimed simulator
   reported `USA` without a signed-in App Store account, so it showed the US
   purchase surface. Only a `nil` storefront fails closed; an absent account
   does not imply `nil`.

### M4 — Android `play`: key-only

- `apps/android/app/build.gradle.kts`: `play` → `buildConfigField("boolean", "LICENSE_LINK_OUT", "false")`.
  Update the flavor comment block, which still says `true` on both at launch.
- Invert `LicenseLinkOutTest`: `direct` must be `true`, `play` must be `false`. It stays the lock.
- Pass the constant through `licenseLinkOut(platform: ANDROID, …)` from M1 rather than
  reading it directly, so the answer has one owner.

Verify: `playDebug` on a pooled emulator shows the key-only plate (M2 copy, no Buy);
`directDebug` unchanged; both flavors activate via key field and deep link.

### M5 — Android `direct`: Custom Tab, and a safe way back

- Extract the tab launch from `CustomTabsAuthSheet.open` into one helper (for example
  `ui/CustomTabs.kt` `openInCustomTab(activity, url)`, with the same `ACTION_VIEW` fallback) and
  use it from both the hosted sheet and `LicenseSettingsSection.open`. Keep `mailto:`
  (Lost-your-key) on `ACTION_VIEW`.
- **Return path.** On the emulator, buy through the tab and tap ACTIVATE. If `adb shell dumpsys
  activity activities` shows a second `MainActivity`, route the `futonotes` intent filter
  through a small no-UI trampoline activity that forwards the intent to `MainActivity` with
  `FLAG_ACTIVITY_CLEAR_TOP | FLAG_ACTIVITY_SINGLE_TOP` (pops the tab, delivers `onNewIntent`) and
  finishes. That is the flag pair `CustomTabsAuthSheet.closeAndReturn` already uses. Move the
  manifest comment with it, and point `LicenseSurfaceTest`'s scheme assertion at the new
  activity. Cold start (app not running) must still activate.
- Fix the "always the top of the task" comment either way.

Verify on a pooled emulator, `directDebug` against staging: Buy → Custom Tab → checkout → key
page → ACTIVATE → back in the app, Licensed, one `MainActivity` in `dumpsys`; repeat from a
cold start; back-press from the tab returns to Settings unchanged.

### M6 — Spec, then a real purchase on each shape

- `docs/spec/license.md`: rewrite § Getting a license's "system browser" bullets per platform
  (iOS US default browser; Android `direct` Custom Tab; Android `play` and iOS non-US no link),
  drop "Not built yet" from the 2026-09-24 decision, delete the superseded 2026-09-09 bullet,
  close the region-gating Gap with the verification evidence, and update the per-platform
  pointers (`LicenseStorefront.swift`, the Custom Tab helper). Use the `spec-sync` skill.
- Real production purchases with coupon `TESTINPROD`, recorded on video like the 2026-09-24
  run: iOS Release with a US storefront (TestFlight, US sandbox account), and Android `direct`
  release through the Custom Tab.
- QA the key-only shapes on both platforms with a production key pasted into "I already paid".

### M7 — Store submission

- **App Review notes (iOS)**: "The FUTO Notes license unlocks no features or content; every
  function of the app is free. The License card only records that the user supports FUTO.
  Outside the US storefront the app offers no purchase and no link; users may enter a key
  bought elsewhere. On the US storefront, 'Buy a license' links to our website under guideline
  3.1.1(a)."
- **Store listings, both stores**: no mention of buying, pricing or our website. Listing text is
  per locale, not per storefront, so a US-only sentence would show in every country.
- TestFlight check with a **non-US** sandbox tester before submitting: key-only plate, no
  Buy. The device steps and result fields live in `docs/qa/license-store-ios.md`.

## 3. Out of scope

- **Hosted sync checkout** (`apps/ios/Sources/Sync/Hosted/AuthSheet.swift`, in-app
  `ASWebAuthenticationSession`). It is under `FUTO_HOSTED_SYNC`, off for store builds, and needs
  its own ADR-0005 treatment before that flag reaches the store.
- Option B (IAP twin), the EU/Japan entitlement, and Google's US External Content Links program.
- Desktop.

## 4. Open questions for @justin

1. **Key-only copy.** Is "Have a FUTO Notes license? Enter your key to activate it on this
   device." right? Should the "I already paid" button keep that label in key-only mode, or say
   "Enter license key", since "paid" hints at a purchase the app cannot offer?
2. **Lost-your-key outside the US.** It is a `mailto:` to support, not a purchase link, but the
   existing contract hides it with the rest. This plan keeps it hidden. Say if you want it back.

## 5. Risks

- **3.1.1 "license keys"** is the one rule option A does not satisfy on its face. Mitigation:
  the review note above; fallback D7.
- **Storefront latency.** `Storefront.current` is async; D3's `false` start means a US user
  briefly sees the key-only plate on a cold open of Settings. Acceptable; never the reverse.
- **The US rules can move**: the *Epic v. Apple* commission rate is pending, and Google's US
  fees start 2026-10-01 to 2026-12-01. Re-read the sources in ADR-0005 before each submission.
