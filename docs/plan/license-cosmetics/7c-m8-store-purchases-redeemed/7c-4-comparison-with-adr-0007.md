### 7c.4 Comparison with ADR-0007 (offline proof)

| | ADR-0007: offline Apple JWS in Rust | 7c: redeem for a FUTOpay key |
|---|---|---|
| lib-polar | none | M (L1-L6) |
| FUTO Notes Rust | verifier + roots + chain/role/date rules + new proof type through `evaluate`/FFI/Tauri + test CA + real golden: L, highest risk | redeem workflow + POST transport: M |
| iOS shell | StoreKit + Restore + `Transaction.updates` revocation removal | StoreKit + Restore + pending state |
| Android / desktop | verify a synced Apple JWS (needs M6 or nothing) | a real key, typed in with one request, or via M6; works without sync |
| M6 | two proofs, ranking, tombstone-for-refund | one proof kind |
| Licensed after purchase | instantly, offline | after one FUTOpay round trip (pending state if it fails) |
| FUTOpay availability | irrelevant | a hard dependency at purchase and at Restore, and **during App Review** |
| Sandbox (Q7) | client rule needing `AppTransaction.environment` | server flag; TestFlight/review hit production FUTOpay |
| Apple roots / chain rules (Q8) | ours to get right and keep current | Apple's library's |
| Display (Q10) | no key, no `issued_at` | a normal key card |
| Privacy | JWS never leaves the device | JWS (with `originalTransactionId`) goes to FUTO |
| Account binding | proof bound to Apple ID, portable only via the vault | key is bearer and portable; Apple ID only needed to Restore |

Open questions that disappear: Q8 (roots, validation time: the library), Q10 (display), the
tagged-proof part of M6, Q7's client-side `AppTransaction` input. Q9 shrinks. New ones: the
Sandbox containment above, whether the card may retry on open, the proxy rate limit, and the
prod-deploy ordering before submission.

Risks of 7c worth naming: (1) money taken but no key when FUTOpay is down, softened by
Apple's durable transaction and Restore, but a support burden; (2) App Review runs against
production FUTOpay, so an outage or a mis-set Apple app id is a rejection (guideline 2.1) with
no client-side fix; (3) a server bug is fixed in minutes, a verifier bug in the shipped app
needs a release; (4) FUTOpay being ever retired strands Restore (existing keys keep verifying
offline); (5) the Sandbox-mints-production-keys exposure.

**Recommendation, taken as D29.** Take 7c. It deletes the riskiest, least-verified piece of ADR-0007 (a
hand-written Rust copy of Apple's `ChainVerifier`, which ADR-0007 itself says nobody has read),
reuses the one mint path and the one client rule that already ship, and gives Android and
desktop a real key. Its price is a hard FUTOpay dependency at purchase and review time and a
privacy reversal (the JWS goes to FUTO), both of which are bounded and operable. Order: L1-L3
and L4 on staging first, then A1-A2 against a TestFlight build with `FUTO_LICENSE_ENV=staging`,
then production deploy, then submit. Land v2 first only if the short-expiry Sandbox containment
is wanted; it is not required for correctness.

Not verified: the Apple library was read through a summarizing fetch of its README and
`signed_data_verifier.py`, not a checkout, so exact exception class names and the
`JWSTransactionDecodedPayload` field names should be confirmed against the installed version;
Apple's own JWSTransaction/`jwsRepresentation` doc pages returned 404 to the fetch tool; that
TestFlight purchases are Sandbox-environment is from general knowledge (ADR-0007 states it the
same way); what fronts pay2 (rate limit), the deployment repo's env handling, and whether a
Sandbox `originalTransactionId` is reused across tester resets were not checked; no code was
run in either repo.
