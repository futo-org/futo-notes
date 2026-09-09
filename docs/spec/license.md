# License — Spec

FUTO Notes is free to use. A user may **buy a license** for the client. The
license unlocks nothing functional: it removes the ambient **Unlicensed** label
and shows a **Supporter since {year}** badge. This is the Grayjay / FUTO Keyboard
/ Immich model ("unregistered HyperCam 2"), sold through FUTOpay (pay.futo.tech,
Polar underneath). The server product is a separate, later product with no
shared semantics; see [Out of scope](#out-of-scope).

Design decisions recorded 2026-09-09 (spec-first; no platform implements this
yet — see the Gaps at the end).

## Principles

- **Nothing is gated.** Every feature works identically licensed or not. The
  only differences are the label, the badge, and the License row's state. Never
  add a licensed-only feature, theme, icon, or limit; a requested "cosmetic"
  feature that non-payers would want is a gate by another name.
- **It is a purchase, never a donation.** Copy says "license", "buy", "renew".
  The word "donate" never appears anywhere in the product, store listing, or
  spec. (Stores treat donations differently and enforce against donation links;
  FUTO is not a nonprofit, so the word would also be inaccurate.)
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
  Danger zone).

## Getting a license

- **Buy** opens the **system browser** (never an in-app WebView) at
  `https://pay.futo.tech/futo-notes?platform=<desktop|ios|android>`. Both URLs
  in this spec are constants in the Rust crate so all three shells agree; the
  web side may redirect freely so the app never needs a release for a
  storefront change. The `platform` value is attribution only.
- After checkout, FUTOpay's activate-redirect page opens
  `futonotes://license/{key}/{activation}`; the app handles it per
  [Deep link](#deep-link). The page also shows the key and activation as text,
  so paste is always possible.
- **Lost key**: the License row offers "Lost your key?" which opens
  `mailto:support@futo.tech`. There is no in-app restore flow (see Gaps).
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
  atomic: verify-then-store happens in Rust as one call (§4.6).

## Deep link

- The scheme is **`futonotes`** on all three platforms: iOS `CFBundleURLTypes`,
  Android an exported `VIEW`/`BROWSABLE` intent filter on the main activity,
  desktop the Tauri deep-link plugin (the Tauri shell is desktop-only). Dev
  builds register the same scheme; whichever build the OS routes to will verify
  against its own key, so a production link opened by a dev build fails cleanly
  as Invalid.
- Only the path `license/{key}/{activation}` is defined. Any other host or path
  is ignored silently.
- A valid link **replaces** an existing license without confirmation and shows
  the "License activated" toast. An invalid link shows one toast, "This license
  link isn't valid", and changes nothing. No dialog, no navigation; if Settings
  is open its License row updates in place.
- A link arriving while the app is cold-starting is handled after the shell is
  interactive (M1): the shell renders first, then applies the link.

## States and copy

The License row has exactly three states. All strings are catalog entries
(`languages/en.json`, prefix `license.`); dates render in the user's locale
(localization.md); the year in "Supporter since" is the year of `issued_at`.

| State | Row text | Actions |
|---|---|---|
| **Unlicensed** | "Unlicensed" | **Buy a license** · **Enter license key** · Lost your key? |
| **Licensed** | "Licensed · Supporter since {year} · Valid until {date}" | **Remove license** |
| **Expired** | "License expired {date} · Supporter since {year}" | **Renew** · **Enter license key** · Lost your key? |

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
    Clicking it opens Settings at the License row.
  - *(native shells)* Mobile has no ambient label outside Settings; the License
    row is the **first row at the top of Settings** and its status text is the
    label.

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
    the key field and deep link (the consumption-only shape). The iOS fallback
    beyond that is a non-renewing-subscription IAP twin at the same price to
    fit 3.1.3(b); a 3-year expiring license cannot be a non-consumable IAP.
  - *(Android)* the app gains **`play` and `direct` product flavors now**, same
    `applicationId` (`com.futo.notes`, `.dev` suffix unchanged) and same signing,
    so a user can move between Play and a direct APK. At launch the flavors
    differ in nothing license-related; `LICENSE_LINK_OUT` can be flipped for
    `play` alone. Other Play-only behavior (e.g. in-app review prompts) also
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

> **Gap:** No revocation check — refunded or revoked keys stay valid on
> activated devices because the license module makes no background requests.
> An opportunistic re-check on explicit user action only would be the
> compatible way to add one.

> **Gap:** No platform surfaces this spec yet (desktop, iOS, Android): no
> `futonotes://` scheme registered, no License row, no ambient label, no Android
> flavors. The rules themselves exist — `crates/futo-notes-license` owns them and
> `tests/conformance/license.json` pins them — but nothing is projected through
> Tauri or UniFFI and no shell reads them. The three platforms ship together.

> **Gap:** The production and staging org public keys are placeholders. The real
> FUTO Notes FUTOpay key pairs are created in lib-polar; until they land,
> `PRODUCTION_PUBLIC_KEY_BASE64` is a throwaway key whose private half was
> discarded (a release build therefore reports every user Unlicensed, which is
> fail-closed) and `STAGING_PUBLIC_KEY_BASE64` is the conformance fixture's
> public key, so a dev build can be driven with a fixture license.
