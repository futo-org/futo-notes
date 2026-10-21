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
