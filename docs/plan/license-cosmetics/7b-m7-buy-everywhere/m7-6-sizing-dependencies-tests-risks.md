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
