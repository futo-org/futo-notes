### M7.5 Store setup (human checklist, @justin; no agent can do it)

**App Store Connect**
1. Agreements, Tax and Banking: Paid Apps agreement signed, bank and tax forms done (IAP cannot be
   tested for real without them; sandbox works earlier).
2. Join the **Small Business Program** if eligible (15% instead of 30%); confirm the rate.
3. Create the **non-consumable** IAP with the product id the Rust constant names, the license price tier,
   Family Sharing off, localized name and description, review screenshot.
4. Sandbox tester accounts; a TestFlight build. Copy the app's numeric **Apple ID** (App Store
   Connect > App Information) into the lib-polar config (`APPLE__APP_APPLE_ID`, § 7c.2).
5. Review notes: free app; the license is one non-consumable IAP; Restore Purchases and the key field
   are in Settings > License; US storefront shows a website link under 3.1.1(a); how to test with the
   sandbox account. Re-read 3.1.1, 3.1.1(a), 3.1.3(b) before submitting (update ADR-0007's snapshot).
6. **Do not submit before production FUTOpay has M8 live with Sandbox acceptance on** (§ 7c.2
   Deploy): App Review's purchase is a Sandbox transaction against production FUTOpay, and a failed
   redemption is a 2.1 rejection with no client-side fix.

**Google Play Console**
1. Merchant account and payments profile (the Play account's payment details and tax info).
2. Create the **one-time in-app product** (`futo_notes_license`), price, activated, for `com.futo.notes`.
3. Copy the app's **Base64 RSA public key** (Monetize > Monetization setup) into the **lib-polar**
   staging and production configs (`GOOGLE__PLAY_PUBLIC_KEY_BASE64`, § 7c.5), not into the client.
4. License testers (Settings > License testing) with test cards; an internal-testing release of the
   `play` AAB (billing needs a Play-installed build).
5. No second Play app (D27): staging purchases use license testers on `com.futo.notes`'s internal
   track.
6. Enroll in Play's **15% service fee tier** if offered/required for the lower rate (the fee page
   says the 15% rate requires enrollment). Update the Data safety form and the store listing for
   purchases (listing text must not name our website for purchase).
