# License — Spec

FUTO Notes is free to use. A user may **buy a license** for the client. The
license unlocks nothing functional: it removes the ambient **Unlicensed** label
and shows a **Supporter since {year}** badge. This is the Grayjay / FUTO Keyboard
/ Immich model ("unregistered HyperCam 2"), sold through FUTOpay (pay.futo.tech,
Polar underneath). The server product is a separate, later product with no
shared semantics; see [Out of scope](#out-of-scope).

Design decisions recorded 2026-09-09 (spec-first). All three clients implement
the whole surface as of 2026-09-09, each driven on its own dev build against a
staging-signed fixture license: all three states, all three input shapes (the
bare key only as far as its 404 — see the Gaps), the deep link, Buy, Remove and
Full reset. *(android)* Both distribution flavors were driven, and the
consumption-only shape was driven too, by building `play` with
`LICENSE_LINK_OUT=false`.

## Principles

- **Nothing is gated.** Every feature works identically licensed or not. The
  only differences are the label, the badge, and the License row's state. Never
  add a licensed-only feature, theme, icon, or limit; a requested "cosmetic"
  feature that non-payers would want is a gate by another name.
- **It is a purchase, never a donation.** Copy says "license", "buy", "renew".
  The word "donate" never appears in the product or the store listing. (Stores
  treat donations differently and enforce against donation links; FUTO is not a
  nonprofit, so the word would also be inaccurate.) The rule scopes to shipped
  copy, not to this spec: naming the forbidden word in order to forbid it is
  what makes the rule checkable.
- **Price lives only in Polar and on the web.** The client never displays,
  fetches, or hardcodes a price. The Buy action opens the web checkout; the
  price is seen there.
- **Rust owns the rule.** Parsing, verification, expiry, deep-link parsing, and
  the single activation network call live in one Rust crate,
  `futo-notes-license`, projected through Tauri and UniFFI. Shells own only UI,
  URL-scheme registration, and preference storage (AGENTS.md §4.1, §4.6). No
  Swift, Kotlin, or TypeScript copy of any license rule.
- **Zero background network.** The license module contacts the network only on
  an explicit user action (entering a bare key). It never validates on launch,
  never polls, never phones home. Offline-first and privacy win over revocation.
- **Typing is sacred (M5).** License state is read once into reactive state; no
  per-keystroke or per-render verification.

## The license

- A license is a **license key** plus an **activation**.
  - **License key**: the FUTOpay format — eight groups of four characters from
    the FUTOpay alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ123456789`), hyphen-separated,
    optionally preceded by an org prefix and a hyphen (e.g.
    `FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78`). Matching is case-insensitive
    and ignores surrounding whitespace.
  - **Activation (v2)**: `v2.<payload>.<signature>` where `<payload>` is
    base64url (no padding) of canonical JSON and `<signature>` is base64url (no
    padding) of an RSA-SHA256 PKCS#1 v1.5 signature over the exact payload
    bytes. Payload fields:
    - `key` — the license key, uppercase, exactly as signed;
    - `product` — the FUTOpay product slug; for this app `futo-notes`;
    - `issued_at` — RFC 3339 UTC purchase time; the source of "Supporter since";
    - `expires_at` — RFC 3339 UTC, or `null` for perpetual products. For
      `futo-notes` the server sets it to `issued_at` + 3 years. The client
      never knows or assumes a duration; it only compares `expires_at`.
  - The v1 FUTOpay activation (a bare base64url RSA signature over the key
    string, as Grayjay uses) carries no product or expiry and is **not** accepted
    by FUTO Notes. Other FUTO apps keep accepting v1; the v2 format is shared so
    they can adopt expiry. Server side: lib-polar (separate repo); the contract
    is defined here and pinned by fixtures (below).
- **Licensed** means all of: the activation parses as v2, the signature verifies
  against the baked-in FUTOpay public key for this app's org, `payload.key`
  equals the stored license key, `payload.product` is `futo-notes`, and the
  current time is before `expires_at` (or `expires_at` is null). Nothing else.
  Verification is fully offline.
- **Expired** means everything above holds except the time check. An expired
  license is kept on the device and still yields "Supporter since".
- **Invalid** is any other outcome. Invalid input is never stored.
- **Keys and org**: FUTO Notes has its own FUTOpay org and RSA key pair. The
  release build embeds the production public key and talks to
  `https://pay2.futo.org`; dev builds (the `.dev` bundle/package IDs, M3) embed
  the staging public key and talk to `https://staging-pay2.futo.org`. Selection
  follows the existing dev/prod split — a dev build can never verify or fetch a
  production license, and vice versa. Fetching a public key at runtime is not
  allowed.
- **Fixtures**: `tests/conformance/license.json` holds a **test-only** RSA key
  pair, plus golden vectors for: valid; expired; wrong product; tampered
  payload; wrong key; v1 activation (rejected); malformed base64; each accepted
  input shape from [Entering a key](#entering-a-key). The Rust crate's tests
  read the goldens, so the verifier is provable before the server ships v2. The
  fixture private key is never used outside tests.
- **Clock**: the client trusts the device clock. A user who sets their clock
  back to appear licensed has spent effort to see a badge; no countermeasure.
- **Revocation and refunds**: with no background network, a refunded or revoked
  key keeps working on every device that already activated. This is a deliberate
  trade for offline-first and privacy; the stakes are a badge. (See Gaps.)
- **Storage**: license key and activation are stored as two plain strings in
  the platform's app-private preferences (UserDefaults / SharedPreferences /
  the desktop app data dir), never in the vault, never in the OS keyring, and
  inside the dev/prod-split data location (M3). They survive app updates and
  are wiped by **Full reset** like every other preference (see settings.md,
  Danger zone). *(ios)* `UserDefaults.standard` is scoped to the bundle id, so
  the dev/prod split is the app sandbox itself. →
  `apps/ios/Sources/License/LicenseStorage.swift` (`futo.license.key`,
  `futo.license.activation`), `FullReset.swift`, `LicenseModel.clearForFullReset`
  *(android)* `SharedPreferences` in the app-private `futo_prefs` file, whose
  package is `.dev`-suffixed on debug builds, so the split is the Android
  sandbox itself. Full reset removes both keys with the vault. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseStorage.kt`
  (`Prefs.LICENSE_KEY`, `Prefs.LICENSE_ACTIVATION`),
  `SettingsScreen.kt` (the Danger-zone confirm calls
  `LicenseModel.clearForFullReset`), `LicenseModelTest`
  "fullResetWipesTheStoredLicenseSilently"

## Getting a license

- **Buy** opens the **system browser** (never an in-app WebView) at
  `https://pay.futo.tech/futo-notes?platform=<desktop|ios|android>`. Both URLs
  in this spec are constants in the Rust crate so all three shells agree; the
  web side may redirect freely so the app never needs a release for a
  storefront change. The `platform` value is attribution only. *(desktop)* The
  URL is read from the crate through `license_links` and opened with the opener
  plugin, never in a webview. → `license::license_links`,
  `src/lib/platform/openExternalUrl.ts`, `LicenseSettingsSection.svelte`
  *(ios)* The URL comes from the same crate constants through
  `licenseLinks(platform: .ios)` and opens with SwiftUI's `openURL`, which hands
  an `https` URL to the system browser. →
  `apps/ios/Sources/License/LicenseSettingsSection.swift`, `LicenseSurfaceTests`
  *(android)* The same crate constants through `licenseLinks(LicensePlatform.ANDROID)`,
  opened with an `ACTION_VIEW` intent, which the OS routes to the browser — never
  a WebView. →
  `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
  `LicenseSurfaceTest` "theBuyLinkIsThisPlatforms"
- After checkout, FUTOpay's activate-redirect page opens
  `futonotes://license/{key}/{activation}`; the app handles it per
  [Deep link](#deep-link). The page also shows the key and activation as text,
  so paste is always possible.
- **Lost key**: the License row offers "Lost your key?" which opens
  `mailto:support@futo.tech`. There is no in-app restore flow (see Gaps). →
  *(desktop)* `license::license_links`, `LicenseSettingsSection.svelte`;
  *(ios)* `licenseLinks(platform:).support`, opened with `openURL`;
  *(android)* the same `support` constant, opened with the same `ACTION_VIEW`
  intent as Buy — the OS hands a `mailto:` to the mail client
- No IAP, no Play Billing, no in-app price, no in-app checkout on any platform.

## Entering a key

- One text field, labelled "License key". It accepts, after trimming
  whitespace, any of:
  1. a bare license key;
  2. `{key}/{activation}`;
  3. the full `futonotes://license/{key}/{activation}` URL.
  Recognition of the three shapes is one Rust function shared with the deep-link
  handler.
- Shapes 2 and 3 verify **fully offline** and never touch the network.
- Shape 1 requires **one** request: `GET
  {pay2}/api/v1/activate/{url-encoded key}` returns the v2 activation as plain
  text on 200, or 404 (`not found`, `not valid`, `revoked`). The app then
  verifies the pair exactly as for shape 2. Failures:
  - no connectivity / transport error → "Connect to the internet to activate
    this key" (the key is not stored);
  - 404 → "This license key isn't valid";
  - 200 but the pair fails verification → "This license key isn't valid".
  The request carries no identifiers beyond the key; there is no retry loop and
  no background re-attempt.
- On success the pair replaces any stored license, state flips to Licensed (or
  Expired, if the key is already past `expires_at` — still stored, with the
  Expired copy shown), and a toast confirms "License activated". Entry is
  atomic: verify-then-store happens in Rust as one call (§4.6). *(desktop)* That
  call is `license_enter_key`; the shell hands over the raw text and receives the
  new state with its outcome, so it never sequences activate-then-verify and
  never re-reads the status afterwards. →
  `license::license_enter_key`, `src/lib/platform/license.ts`,
  `src/features/license/license.svelte.ts`
  *(ios)* The same one call is `licenseEnterKey(input:bundleId:)`, async because
  the bare-key path makes the one request; the shell persists the returned pair
  and renders the returned state, and never asks again. →
  `crates/futo-notes-ffi/src/license/contract.rs`,
  `apps/ios/Sources/License/LicenseModel.swift`
  *(android)* The same one call is `licenseEnterKey(input, bundleId)`, from a
  coroutine so the bare-key request never touches the main thread; the shell
  persists the returned pair and renders the returned state. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseModel.kt`,
  `LicenseModelTest` "aPastedPairActivatesOffline", "aPastedLinkActivatesOffline",
  "anUnrecognisablePasteStoresNothing"

## Deep link

- The scheme is **`futonotes`** on all three platforms: iOS `CFBundleURLTypes`,
  Android an exported `VIEW`/`BROWSABLE` intent filter on the main activity,
  desktop the Tauri deep-link plugin on Linux, macOS and Windows (the Tauri
  shell is desktop-only). → *(desktop)* `tauri-plugin-deep-link` with
  `plugins.deep-link.desktop.schemes` in `tauri.conf.json`, `license::install`;
  a second launch carrying the link arrives through the single-instance plugin's
  argv (`license::handle_single_instance_arguments`). *(ios)* `CFBundleURLTypes`
  in `apps/ios/Info.plist`, delivered by `.onOpenURL` on the root view. →
  `LicenseSurfaceTests` "the app registers the crate's URL scheme" (asserts the
  shipped plist against the crate's `licenseDeepLinkScheme()`),
  `LicenseModel.handle`. Dev
  builds register the same scheme; whichever build the OS routes to will verify
  against its own key, so a production link opened by a dev build fails cleanly
  as Invalid.
- Only the path `license/{key}/{activation}` is defined. Any other host or path
  is ignored silently. That verdict is the crate's on every platform, never a
  shell's. → `license::parse_deep_link`, *(ios)* the `Ignored` arm of
  `licenseHandleDeepLink`, `LicenseModelTests` "an undefined link is ignored
  silently"; *(android)* the same `Ignored` arm in `LicenseModel.handle`,
  `LicenseModelTest` "anUndefinedLinkIsIgnoredSilently" — driven on the emulator
  as `am start -d futonotes://settings/open`, which left the screen
  byte-identical
- A valid link **replaces** an existing license without confirmation and shows
  the "License activated" toast. An invalid link shows one toast, "This license
  link isn't valid", and changes nothing. No dialog, no navigation; if Settings
  is open its License row updates in place.
- A link arriving while the app is cold-starting is handled after the shell is
  interactive (M1): the shell renders first, then applies the link. *(ios)*
  SwiftUI hands a launch URL to `.onOpenURL` only once the root view exists, and
  the toast rides the transient banner the note list already mounts, so a
  cold-start link is applied and announced on a painted screen. →
  `apps/ios/Sources/App/FutoNotesApp.swift`, `LicenseModel.handle`; a message
  produced before the app has wired up its banner is parked and flushed the
  moment it has one, so the toast survives even the earliest launch URL. →
  `LicenseModelTests` "a cold-start link is announced once the banner exists"
  *(android)* The launch intent's URL is parked in Compose state during
  `onCreate` and applied by a `LaunchedEffect` after the first composition, so
  the note list is painted before the link lands and the toast appears on it;
  the same state carries a link from `onNewIntent`, so both deliveries take one
  path, and a launch intent is consumed once — a recreation that re-delivers it
  does not re-announce a license the user already has. The stored pair is read
  *and verified* off the main thread (M1), and that answer is not allowed to
  overwrite a license the link applied while it was in flight. →
  `apps/android/app/src/main/java/com/futo/notes/MainActivity.kt`
  (`pendingLicenseLink`), `LicenseModel.load`/`applyStored`, `LicenseModelTest`
  "aLinkAppliedBeforeTheStoredPairLandsSurvivesIt"
  *(desktop)* Rust applies and *parks* the outcome — storing blocks no render — and the shell
  drains it once it has painted, so the toast is delivered exactly once whether
  the link arrived before or after the webview existed. →
  `license::LicenseLinkInbox`, `license_take_pending_link`,
  `license::tests::a_parked_link_outcome_is_delivered_exactly_once`

## States and copy

The License row has exactly three states. All strings are catalog entries
(`languages/en.json`, prefix `license.`); dates render in the user's locale
(localization.md); the year in "Supporter since" is the year of `issued_at`.

| State | Row text | Actions |
|---|---|---|
| **Unlicensed** | "Unlicensed" | **Buy a license** · **Enter license key** · Lost your key? |
| **Licensed** | "Licensed · Supporter since {year} · Valid until {date}" | **Remove license** |
| **Expired** | "License expired {date} · Supporter since {year}" | **Renew** · **Enter license key** · Lost your key? |

- A **perpetual** license (`expires_at` is `null`) is still the Licensed state;
  the row simply drops the "Valid until" clause rather than inventing a date:
  "Licensed · Supporter since {year}". → `license.licensedPerpetual`,
  `licenseCopy.test.ts` "omits the expiry entirely for a perpetual license"
- Under the row in every state: "FUTO Notes is free to use. Buying a license
  supports development and removes the Unlicensed label."
- **Renew** is the Buy action; a new key simply replaces the old one.
- **Remove license** asks for no confirmation (it is reversible by re-entering
  the key) and returns the device to Unlicensed. It exists for testing and
  device hand-off.
- No state ever shows a price, a countdown, a nag, or a banner. There is no
  pre-expiry notice outside the row's own "Valid until" text.
- **Ambient label** (the thing a purchase removes): the text "Unlicensed" when
  Unlicensed or Expired; "Supporter since {year}" when Licensed. It is
  informational, never interrupts, never appears inside the editor, never on
  exported or shared content, and never on user data (M2).
  - *(desktop)* A footer line in the list/sidebar view, beside the app version.
    Clicking it opens Settings at the License row. The License section sits
    after Updates and before the Danger zone, which stays last. →
    `src/features/license/SidebarLicenseFooter.svelte`,
    `DrawerSidebar.svelte`, `SettingsScreen.svelte` (`initialSection`),
    `licenseCopy.ts` + `licenseCopy.test.ts`
  - *(native shells)* Mobile has no ambient label outside Settings; the License
    row is the **first row at the top of Settings** and its status text is the
    label. → *(ios)* `LicenseSettingsSection` as the first `Section` of
    `SettingsView`, `LicenseCopyTests`; *(android)* `LicenseSettingsSection` as
    the first `SettingsGroup` of `SettingsScreen`,
    `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
    `LicenseCopyTest`

## Store posture (deliberate, recorded 2026-09-09)

Research summary as of 2026-09-09; this area changes monthly and the decision,
not the rules, is what this section records.

- **Apple.** Guideline 3.1.1 names license keys as a forbidden unlock mechanism
  worldwide; 3.1.3(b) permits recognising a web-bought license only if the same
  thing is also sold as IAP. Linking out is legal in the US (no entitlement, 0%
  today, rate pending in court), in the EU and Japan at 15% with Apple's
  disclosure sheet and an IAP twin, in Brazil, and banned elsewhere. Immich
  ships a free iOS app with a key field and no IAP twin today.
- **Google.** A Play build that only accepts a pasted key with no clickable
  path to checkout is explicitly permitted (consumption-only, 0%, no
  enrollment). Any link requires the External Content Links / billing choice
  programs, which cover the US, EEA, UK and Japan today, with fees from October
  2026 and worldwide coverage not before September 2027. Google enforces after
  publication (removals, strikes) and has enforced against external payment
  links in 2026.
- **Decision.** All three platforms ship the full surface — key field, deep
  link, and the Buy link to the system browser — **worldwide**, with no region
  gating and no IAP or Play Billing twin. FUTO accepts the review risk and will
  respond if a store objects. If it does, the answer is a flag flip, not a
  redesign:
  - one build-time constant, `LICENSE_LINK_OUT`, exists on iOS and Android and
    is `true` at launch. `false` hides Buy, Renew and Lost-your-key and keeps
    the key field and deep link (the consumption-only shape). Which controls
    each value produces is decided once in Rust, so the two shells cannot drift
    on what the flag means. → `license_row_actions`,
    `crates/futo-notes-ffi/src/license/contract.rs` "link_out false hides every
    way out of the app and nothing else"; *(ios)*
    `apps/ios/Sources/License/LicenseLinkOut.swift`, flipped by the
    `LICENSE_LINK_OUT_DISABLED` compile condition (`apps/ios/project.yml` names
    it where the build is configured); *(android)* a `buildConfigField` on each
    product flavor in `apps/android/app/build.gradle.kts`, read once as
    `BuildConfig.LICENSE_LINK_OUT` and passed to `licenseRowActions`, so `play`
    alone can be flipped. `LicenseLinkOutTest` runs under both flavors and
    fails the one whose constant is false — the lock that makes "true at
    launch" a fact rather than an intention. Building `play` with `false` was
    driven on the emulator: Buy, Renew and Lost-your-key disappeared while the
    key field and the deep link kept working. The iOS fallback
    beyond that is a non-renewing-subscription IAP twin at the same price to
    fit 3.1.3(b); a 3-year expiring license cannot be a non-consumable IAP.
  - *(Android)* the app gains **`play` and `direct` product flavors now**, same
    `applicationId` (`com.futo.notes`, `.dev` suffix unchanged) and same signing,
    so a user can move between Play and a direct APK. At launch the flavors
    differ in nothing license-related — `LICENSE_LINK_OUT` is `true` on both —
    and it can be flipped for `play` alone. Other Play-only behavior (e.g. in-app review prompts) also
    belongs in the `play` flavor. F-Droid builds `direct`.
  - *(Android, F-Droid)* offline verification adds no anti-feature; the single
    activation request to pay2 may earn a Tethered/NonFreeNet label. Accepted.
- **Never** frame the purchase as a donation in the app or the store listing
  (see Principles).

## Out of scope

- The **server product** is independent: its own Polar product, its own key
  semantics, no shared entitlement with this license. The same customer e-mail
  may exist in Polar for both; nothing in the client relies on that.
- Per-region pricing, currencies, and tax are the storefront's business.

> **Gap:** License sync — the license is entered per device. Carrying it in the
> E2EE sync payload so one entry licenses every synced device is intended but
> not designed; it touches the sync payload (AGENTS.md §11.6) and must be its own
> change.

> **Gap:** No in-Play purchase path — Play users must reach pay.futo.tech via
> the Buy link or on their own. A Play Billing SKU or companion app (the FUTO
> Keyboard pattern) is deliberately not built.

> **Gap:** No region gating — the Buy link shows worldwide on iOS and Android
> regardless of storefront country; StoreKit `Storefront`-based gating is the
> fallback if Apple objects, alongside the `LICENSE_LINK_OUT` flag.

> **Gap:** No in-app restore by e-mail — lost keys go to support@futo.tech; the
> newer futopay Android library's restore page is not adopted.

> **Gap:** The bare-key path's **success** answer has never been seen from a
> real server. `staging-pay2.futo.org` is up and answers the endpoint — QA on
> iOS 2026-09-09 entered the fixture key on a dev build and got a genuine 404
> (`{"detail":"Not a valid License Key - No product found."}`), rendered as
> "This license key isn't valid" with nothing stored, which is the specified
> behavior. But no key exists in that org yet (issue #155), so the 200 branch —
> activation text returned, then verified against the staging key — is pinned
> only by the conformance goldens and
> `a_bare_key_makes_exactly_one_staging_request`. Android QA on
> 2026-09-09 reached the same 404 from the emulator, so two clients have now
> exercised the request and neither has seen a 200. The offline
> ("Connect to the internet") branch is likewise fixture-only at runtime.

> **Gap:** No revocation check — refunded or revoked keys stay valid on
> activated devices because the license module makes no background requests.
> An opportunistic re-check on explicit user action only would be the
> compatible way to add one.

> **Gap:** The production and staging org public keys are placeholders. The real
> FUTO Notes FUTOpay key pairs are created in lib-polar; until they land,
> `PRODUCTION_PUBLIC_KEY_BASE64` is a throwaway key whose private half was
> discarded (a release build therefore reports every user Unlicensed, which is
> fail-closed) and `STAGING_PUBLIC_KEY_BASE64` is the conformance fixture's
> public key, so a dev build can be driven with a fixture license.

> **Gap:** _(android)_ The row has a fourth, unspecified state: *not yet known*.
> The spec gives it three, and iOS and desktop always have one of them, because
> they evaluate the stored license synchronously as they build their state. On
> Android both halves of that — a `SharedPreferences` read and a JNI call doing
> an RSA verify — are work M1 keeps off the thread that paints the shell, so the
> row shows its explanation and no status until the answer lands. The window is
> one IO hop during startup and closes long before Settings can be opened, so no
> user is expected to see it; it is recorded rather than blessed, and the line to
> reconcile is whether the spec should name a loading state for all three
> clients. → `LicenseModel.view` (nullable until `load()`),
> `LicenseSettingsSection.kt`

> **Gap:** _(desktop, ios, android)_ The spec names the key field but none of the
> controls around it, so each shell supplies them: an **Activate** button (the
> keyboard's Done/Return also submits), a **Cancel** that closes the field, and a
> placeholder naming the three accepted shapes. A text field with no submit is
> not operable, so these are additions rather than choices — but they are
> unspecified copy, and this is the line to reconcile if the spec later names
> them. All three shells use the same four catalog entries
> (`license.keyLabel`, `keyPlaceholder`, `activate`, `cancelEntry`), so the
> addition is at least identical on all of them.

> **Gap:** _(desktop, macOS)_ The `futonotes` scheme is declared once in
> `tauri.conf.json`, but only Linux and Windows re-register it at runtime
> (`register_all`). macOS learns the scheme from the bundle's generated
> `CFBundleURLTypes`, which an unbundled `cargo tauri dev` binary never gets, so
> the OS → app hop is unverified there: QA drove the plugin's own
> `deep-link://new-url` event, which exercises everything from `on_open_url`
> inward but not LaunchServices. Proving it needs a signed bundle from
> `just tauri-build`, and a production bundle verifies against the production
> key — so a staging license cannot demo it end to end until the real key pair
> lands (see the placeholder-keys gap above).
