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
