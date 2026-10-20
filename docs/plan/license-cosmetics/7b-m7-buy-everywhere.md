## 7b. M7 — Buy everywhere: website where allowed, store purchase where not (does not wait for M6, D28; own MRs)

> **Deferred 2026-10-19.** In-app purchase (StoreKit, Play Billing) is not being built now; the
> routing below does not apply and nothing in this section is a task. Kept whole as the record.
> What ships is the key-only and link-out posture of ADR-0005.

Decisions D15-D29; [ADR-0007](../../adr/0007-ios-sells-the-license-in-app.md) for the routing and
the store surfaces, [ADR-0008](../../adr/0008-store-purchases-are-redeemed-for-a-key.md) for what a
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

- [M7.0 Routing table (rules read 2026-10-16; re-read before each submission)](7b-m7-buy-everywhere/m7-0-routing-table.md)
- [M7.1 Rust (`crates/futo-notes-license`, `crates/futo-notes-ffi`): redemption and routing (size S-M)](7b-m7-buy-everywhere/m7-1-rust-redemption-and-routing.md)
- [M7.2 iOS shell (`apps/ios/Sources/License/`, size M)](7b-m7-buy-everywhere/m7-2-ios-shell.md)
- [M7.3 Android shell, `play` flavor only (size M)](7b-m7-buy-everywhere/m7-3-android-shell.md)
- [M7.4 UI and copy (size S, both shells plus Tauri strings)](7b-m7-buy-everywhere/m7-4-ui-and-copy.md)
- [M7.5 Store setup (human checklist, @justin; no agent can do it)](7b-m7-buy-everywhere/m7-5-store-setup.md)
- [M7.6 Sizing, dependencies, tests, risks](7b-m7-buy-everywhere/m7-6-sizing-dependencies-tests-risks.md)
