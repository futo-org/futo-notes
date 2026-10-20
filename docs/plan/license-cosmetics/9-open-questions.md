## 9. Open questions for @justin

One reconciled set (2026-10-16). Earlier per-pass notes were merged here.

**Deferred 2026-10-19 (@justin).** D15–D32 and everything built on them (store purchases,
redemption, the lib-polar MR, the key-only copy retiring). Nothing below under those decisions is
open or scheduled; the "Decided" and "Open" items that refer to them are the record. Separately,
the key-only wording is under review.

**Decided.**
- Picker treatment A (D11). iOS Expired -> Renew accepted on unit coverage. M6 waits for its own MR (deferred, D28).
- Q1 Expired closes the picker; Q2 the toast is enough on desktop; Q4 the row hint shows everywhere;
  Q5 the card paragraph is the sketch wording (`license.explanation`). Taken as written, reopen if wrong.
- **Refunds out of scope** (D18; Q9 reduces to "a Remove tombstone wins over an offline device").
- **Buy everywhere** (D17), **US iOS -> website** (D21, Q6).
- **D29, store purchases are redeemed for a FUTOpay key, 2026-10-16:** § 7c adopted for both
  stores (ADR-0008); supersedes D19 "no server work", D20 (Sandbox moves server-side), D22 (Google
  offline) and D26 (the card is the normal key card). The client never verifies a store proof. Q8
  below is moot in this repo (the Apple library owns roots and chain rules).
- **D28, punt on license sync (M6), 2026-10-16:** M6 is deferred, not cancelled; M7 ships without it; D16 is superseded. Q3 below stays decided for when M6 is picked up.
- **Q3, M6 carrier: the hidden engine slot**, a reserved path kept in engine state, never a file in
  the notes folder; any valid proof counts, duplicates keep one, a Remove tombstone beats an offline
  device (@justin 2026-10-16; § 7 Feasibility option (a)).
- **Q8, Apple roots: all three** (Apple Root CA, G2, G3), under D29 as DER files in lib-polar (§ 7c.2) rather than in the binary, with the Apple
  library's chain rules (three certificates; leaf OID `1.2.840.113635.100.6.11.1`, intermediate
  `1.2.840.113635.100.6.2.1`, re-confirm against a checkout; validity at the signed date).
  Tests inject the Xcode StoreKit anchor in test code only; a test asserts the release anchor set
  is exactly Apple's roots.

**Open, for @justin (recommendations in § 7b M7.0).**
- D-A, D-B, D-C and Q10: **resolved 2026-10-16** as D23–D26 (D26 since superseded by D29).
- Q11: **resolved 2026-10-16** as D27 (no second Play app).
- Q12 (Sandbox containment), Q13 (retry on open) and Q14 (one lib-polar MR or two): **resolved
  2026-10-16** as D30, D31, D32. Nothing is open.

Unverified, to settle by a real fixture or a Play Console look: the Google signature hash (SHA-1 per
the long-standing sample) and key format, Google's current fee figures, the Apple library's exact
exception and payload names (§ 7c.2 read it through a summarizing fetch), and whether a Sandbox
`originalTransactionId` survives a tester reset.
