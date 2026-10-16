# Store purchases are redeemed for a FUTOpay key

Decided by @justin on 2026-10-16. Supersedes [ADR-0007](0007-ios-sells-the-license-in-app.md)
items 4 (no server work), 5 (three proofs, verified offline in Rust), 7 (the client's Sandbox rule)
and 8 (Apple roots in the binary), and its two "what offline verification is, and is not" sections.
ADR-0007's routing (items 1-2), refunds out of scope (3), the deferred M6 carrier (6) and the store
surfaces (9) stand. Not implemented; this records the decision and the design. Plan:
`docs/plan/license-cosmetics.md` D29, § 7b (client, store setup), § 7c (server, task lists).

ADR-0007 chose to verify the App Store signed transaction and the Google Play signed purchase in
the client, offline, so that FUTOpay/lib-polar would not change. With license sync deferred (plan
D28) that left a store purchase licensing only the store it was made in: an iPhone buyer outside the
US, who cannot be told about the website, had nothing that worked on Android or desktop. The plan's
own scoping of the server alternative (§ 7c) had recommended it; the morning's rejection was about
server process cost, not design. Weighed again the same day against a hand-carried proof (share a
multi-KB deep link, paste it elsewhere), the server path was judged the correct one: the only option
whose result is a key, which the whole license design already knows how to carry.

## Decision

1. **A store purchase becomes an ordinary FUTOpay license.** On a StoreKit or Play Billing
   purchase the app makes one user-initiated `POST` to FUTOpay carrying the store's signed proof
   (`jwsRepresentation`; `Purchase.getOriginalJson()` + `getSignature()`). lib-polar verifies it and
   answers `{license_key, activation}` minted through the existing `create_key_func`, or the same
   pair again for a proof it has seen. The client feeds the pair to the unchanged Rust `evaluate`
   exactly as a typed or deep-linked pair; nothing is trusted until the baked org key verifies it.
2. **The client holds only FUTOpay pairs.** No `LicenseProof` enum, no Apple roots in the binary,
   no Rust chain verifier, no Play public key in the client. The Licensed card is the normal key
   card (plan D26 superseded). A store buyer reaches any other platform the way a website buyer
   does: reveal the key, enter it there; Restore on the same store; sync once M6 exists.
3. **Server verification.** Apple: the official `app-store-server-library` (Python), all three
   Apple roots, `enable_online_checks=False` (refunds out of scope, no OCSP dependency), one
   verifier per environment (Production, Sandbox), never `XCODE`/`LOCAL_TESTING`; claims checked
   after the library: product id, non-consumable, `inAppOwnershipType == PURCHASED`. Google:
   RSASSA-PKCS1-v1_5 over `original_json` with the app's Play public key (hash to be confirmed
   against a real purchase), then package, product, `purchaseState == 0`, quantity 1; no Developer
   API call, no service account. Identity: Apple `originalTransactionId`, Google `purchaseToken`;
   each in its own table, first sight mints, replay re-serves.
4. **Until redemption succeeds, nothing is granted.** The transaction stays unfinished and the Play
   purchase unacknowledged; the card shows "Purchase received, not yet activated" with Try again and
   Restore. Zero background network holds: Buy, Try again and Restore are the only triggers, no
   retry on launch or on opening Settings. A rejected proof (4xx) stores nothing and shows a support
   path. Google's three-day auto-refund of an unacknowledged purchase is the intended outcome for a
   purchase never redeemed.
5. **Sandbox is a server policy, not a client rule.** Production FUTOpay accepts Sandbox
   transactions because TestFlight and App Review purchases are Sandbox transactions in the release
   binary talking to production FUTOpay. Containment (plan Q12): flag the row now; short-expiry v2
   activations once that branch lands. A Play license-tester purchase is signed like a real one and
   mints a real key; the tester list is the containment, the Developer API's `purchaseType` the
   upgrade path.
6. **Ordering.** lib-polar (plan M8) on staging before any shell QA; on production, with Sandbox
   acceptance on, before any store submission. Debug builds and automated tests use a fake store
   and a fake redeem; the server cannot verify Xcode StoreKit transactions by design.
7. **Refunds stay out of scope** (ADR-0007 item 3). `revocationDate` is ignored; a refunded
   purchase keeps a working key, the same bearer limit as ADR-0004.

## Consequences

- **Reversed from ADR-0007.** "No server work" and "never sent to FUTO": the JWS (carrying
  `originalTransactionId`) or the Play receipt (carrying `purchaseToken`) goes to FUTO once, on a
  tap. "Verified offline in Rust": the client verifies only the pair that comes back. The license
  crate's "exactly one GET" rule becomes "at most one request per explicit user action".
- **New dependency.** FUTOpay is on the purchase path, at Restore, and during App Review. An outage
  delays activation (Apple keeps the transaction; Play refunds after three days); a wrong
  `APPLE__APP_APPLE_ID` during review is a guideline 2.1 rejection with no client-side fix. A server
  bug is fixed without an app release, which is the same fact's upside.
- **Client work shrinks.** The largest unverified piece of ADR-0007, a hand-written copy of Apple's
  `ChainVerifier`, is gone; M7.1 is a redeem workflow and a `post_json` transport. M6, when picked
  up, carries one proof kind.
- **"One license, all platforms" holds the way it does for a website key.** Nothing travels on its
  own until M6, and no copy may say "your license is on all your devices"; the key the card reveals
  works wherever it is entered, including Android `play`, where honoring a key bought elsewhere is
  consumption-only access Google permits.
- **App Review.** Review notes gain: the purchase is activated by a FUTO server call, the sandbox
  account to use, and that Restore re-activates. Privacy copy and the Play Data safety form state
  that a purchase receipt is sent to FUTO to issue the license.
- **Unverified at decision time** (plan § 7c.2, § 7c.5): the Apple library's exact exception and
  payload names were read through a summarizing fetch; Google's signature hash is from the
  long-standing sample; whether a Sandbox `originalTransactionId` survives a tester reset; what
  fronts `pay2` for a body-size and per-IP limit. The first real fixture of each kind settles the
  first two.

Plan: [`docs/plan/license-cosmetics.md`](../plan/license-cosmetics.md) (D29, § 7b, § 7c, M8).
Behavioral truth: `docs/spec/license.md` § Store posture (a Gap until built).
