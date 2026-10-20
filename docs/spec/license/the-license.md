## The license

- A license is a **license key** plus an **activation**.
  - **License key**: the FUTOpay format — eight groups of four characters from
    the FUTOpay alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ123456789`), hyphen-separated,
    optionally preceded by an org prefix and a hyphen (e.g.
    `FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78`). Matching is case-insensitive
    and ignores surrounding whitespace.
  - **Two activation formats are accepted, v1 and v2.** Which one arrives is
    the server's choice; the client answers to both, so FUTOpay can move to v2
    with **no client release**. → `futo_notes_license::activation`
  - **Activation (v1)**: a bare base64url (no padding) RSA-SHA256 PKCS#1 v1.5
    signature over the **license-key string alone** — no envelope, no product,
    no dates. It is what `pay2.futo.org` issues today, and what Grayjay and the
    other FUTO apps use. → lib-polar
    `pylib/futopay_server/licensing/key.py` `verify_key_pair`
  - **Activation (v2)**: `v2.<payload>.<signature>` where `<payload>` is
    base64url (no padding) of canonical JSON and `<signature>` is base64url (no
    padding) of an RSA-SHA256 PKCS#1 v1.5 signature over the exact payload
    bytes. Payload fields:
    - `key` — the license key, uppercase, exactly as signed;
    - `product` — the FUTOpay product slug; for this app `futo-notes`;
    - `issued_at` — RFC 3339 UTC purchase time; the source of "Licensed since";
    - `expires_at` — RFC 3339 UTC, or `null` for perpetual products. For
      `futo-notes` the server sets it to `issued_at` + 3 years. The client
      never knows or assumes a duration; it only compares `expires_at`.
  - Server side: lib-polar (separate repo); both contracts are defined here and
    pinned by fixtures (below).
- **Licensed (v1)** means: the activation is a single base64url segment whose
  signature verifies, against the baked-in FUTOpay public key for this app's
  org, over the normalized stored license key. Nothing else — the key _is_ the
  signed message, so there is no separate key comparison to make. It is
  **perpetual**: `issued_at` and `expires_at` are absent, so the card leaves the
  rows that need them blank, and no clock ever moves it out of Licensed.
- **Licensed (v2)** means all of: the activation parses as `v2.…`, the signature
  verifies against that same org public key, `payload.key` equals the stored
  license key, `payload.product` is `futo-notes`, and the current time is before
  `expires_at` (or `expires_at` is null). Nothing else.
  Verification is fully offline in both formats.
- **Expired** means everything above holds for a **v2** activation except the
  time check. An expired license is kept on the device and still shows its
  "Licensed since" date and its key. A v1 license never reaches Expired — the format cannot
  express an expiry — so Expired and its Renew action are reachable only for a
  v2 activation carrying an `expires_at`.
- **Invalid** is any other outcome. Invalid input is never stored.
- **Keys and org** (read the [one-product tripwire](#decision-2026-09-10--accept-v1-alongside-v2)
  before adding a second product to this org): FUTO Notes has its own FUTOpay org and RSA key pair. The
  release build embeds the production public key and talks to
  `https://pay2.futo.org`; dev builds (the `.dev` bundle/package IDs, M3) embed
  the staging public key and talk to `https://staging-pay2.futo.org`. Selection
  follows the existing dev/prod split — a dev build can never verify or fetch a
  production license, and vice versa. Fetching a public key at runtime is not
  allowed.
- **Fixtures**: `tests/conformance/license.json` holds a **test-only** RSA key
  pair, plus golden vectors for: valid; expired; wrong product; tampered
  payload; wrong key; malformed base64; each accepted input shape from
  [Entering a key](entering-a-key.md#entering-a-key); and, for v1, a valid activation, one signed
  by the wrong org key, one minted for a different license key, and one that is
  not base64url at all. The Rust crate's tests read the goldens, so both
  verifiers are provable before the server ships v2. The fixture private key is
  never used outside tests. The staging-signed activations the native and FFI
  fixtures carry (both formats, minted by
  `scripts/gen-license-fixture.mjs --staging`) are a separate, real key pair.
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
  Danger zone). _(ios)_ `UserDefaults.standard` is scoped to the bundle id, so
  the dev/prod split is the app sandbox itself. →
  `apps/ios/Sources/License/LicenseStorage.swift` (`futo.license.key`,
  `futo.license.activation`), `FullReset.swift`, `LicenseModel.clearForFullReset`
  _(android)_ `SharedPreferences` in the app-private `futo_prefs` file, whose
  package is `.dev`-suffixed on debug builds, so the split is the Android
  sandbox itself. Full reset removes both keys with the vault. →
  `apps/android/app/src/main/java/com/futo/notes/license/LicenseStorage.kt`
  (`Prefs.LICENSE_KEY`, `Prefs.LICENSE_ACTIVATION`),
  `SettingsScreen.kt` (the Danger-zone confirm calls
  `LicenseModel.clearForFullReset`), `LicenseModelTest`
  "fullResetWipesTheStoredLicenseSilently"
- _(native shells)_ Full reset invalidates any activation already in flight. A
  delayed success is discarded without restoring preference storage, changing
  the Unlicensed state, or announcing activation. → iOS and Android
  `LicenseModel` operation revisions; `fullResetInvalidatesPendingActivation`,
  `fullResetInvalidatesAnActivationAlreadyInFlight`

### Decision 2026-09-10 — accept v1 alongside v2

This **reverses specified intent**, recorded as a decision by @justin rather
than as a closed Gap: until 2026-09-10 this spec said the v1 activation "is
**not** accepted by FUTO Notes". It is now accepted, and v2 is kept. Issue #161.

Why the original reasoning did not survive contact with the deployed product:

- **Product binding never came from the payload.** FUTO Notes has its own
  FUTOpay org RSA key pair, so a Grayjay or Immich activation cannot verify
  against this app's public key whatever format it is in. `payload.product` is
  belt-and-braces, not the binding.
- **The deployed product is perpetual.** `GET
/checkout/polar/futo-notes/futo-notes-license/info` reports
  `license_term: null` and `/price` reports a one-time, non-recurring price
  (observed 2026-09-10), so `expires_at` would be `null` even under v2 — Expired
  and Renew are unreachable _from anything the server mints today_, either way,
  until someone sets a term. That is a **product** condition, not a missing code
  path: the client's Expired branch works and was driven on the emulator
  2026-09-10 (#160) by holding the v2 fixture (which carries
  `expires_at` 2029-01-15) and moving the device clock to 2030. The row read
  "License expired Jan 15, 2029 · Supporter since 2026" and offered Renew /
  Enter license key / Lost your key?, with Renew opening the same generated
  checkout as Buy. The same run confirmed the complement: a v1 license held
  under the same future clock stayed simply "Licensed", since no clock can move
  a v1 activation out of Licensed.
- That left `issued_at` — then rendered as the bare year in "Supporter since",
  and since 2026-09-16 as the full date in "Licensed since" (D3) — as the only
  thing v2 buys today. `staging-pay2.futo.org` runs the pre-v2 code, so shipping against
  v1 needs no lib-polar change at all.

**v2 is not removed, and must not be.** Dual acceptance is what lets the server
switch to v2 later with **zero client release** — the shipped mobile apps cannot
be hot-fixed, so deleting the v2 path would turn that migration into two store
submissions. v2 semantics are unchanged whenever a v2 activation arrives.

> **TRIPWIRE — one product per org.** A v1 signature covers the license-key
> string alone, so **any** v1 activation minted by the `futo-notes` FUTOpay org
> verifies for this product. That is safe only while that org mints license keys
> for exactly one product. A subscription product is coming under the same org;
> it issues no license keys, so it does not trip this.
> **If any second product in the `futo-notes` org ever mints a license key, v1
> acceptance must be dropped and v2 becomes mandatory** — a `payload.product`
> check is the only thing that separates two products under one key pair. That
> is the second reason the v2 path stays: dropping v1 must remain a client change
> that is already written, not one that has to be written under pressure.
> Mirrored in `crates/futo-notes-license/AGENTS.md`, which is what a change to
> the verifier makes someone read.
