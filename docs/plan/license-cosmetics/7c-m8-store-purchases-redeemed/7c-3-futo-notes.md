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
