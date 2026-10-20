### M7.0 Routing table (rules read 2026-10-16; re-read before each submission)

| Surface | Buy does | Basis |
|---|---|---|
| iOS, **US** storefront | **Website** (default browser). Restore Purchases still shown. | Guideline 3.1.1(a): no entitlement needed for buttons/links in US storefront apps (Apple, App Review Guidelines, read 2026-10-16). Commission on US link-outs is 0% today; Apple proposed 5-15% in Aug 2026, undecided before the district court, and Apple's merits brief to the Supreme Court was filed 2026-09-14 (9to5Mac 2026-10-12; AppleInsider 2026-08-13). Decision @justin 2026-10-16. |
| iOS, **EU** storefronts | **StoreKit IAP** (decision D-B: recommend) | A link needs the EU entitlement under the unified EU terms effective 2026-10-01: 15% (10% Small Business) on sales within 7 days of the tap, 5% Core Technology Commission, monthly transaction reports, self-remitted tax (Apple, apps-in-the-EU page, read 2026-10-16; the page was ambiguous on one fee line). |
| iOS, **Japan** | **StoreKit IAP** (D-B) | Link allowed since iOS 26.2 (2025-12-17) at 15% (10% reduced programs) but always presented **alongside** IAP, and no refunds for those sales (Apple Newsroom 2025-12-17). Same commission as IAP at the Small Business rate, plus reporting: nothing gained. |
| iOS, **every other storefront** (and unknown) | **StoreKit IAP** | 3.1.1(a): buttons, links and other calls to action to non-IAP purchase are banned outside the US and the entitlement storefronts. Brazil has an entitlement; treated like the EU (D-B). Unknown storefront fails closed to IAP. |
| Android **`direct`** (GitLab, Obtainium, F-Droid) | **Website** (Custom Tab) | Distributed outside Google Play; no Play policy applies (ADR-0005, unchanged). |
| Android **`play`**, **US** | **Play Billing** (D-A: recommend) | Google says it will not prohibit US developers from linking out or promoting outside pricing since 2025-10-29 (Play Console Help 15582165, read 2026-10-16), but the formal vehicle is the **External Content Links** program: enroll, integrate its APIs, report every transaction (from 2026-10-01, download-fee deadline moved to 2026-12-01 on 2026-09-17), fees on purchases within 24 h of a tap (Play Console Help 16470497; listed rates 10-20%). Whether an un-enrolled US link is safe from enforcement is not settled by any page we found. |
| Android **`play`**, **EEA / UK** | **Play Billing** (D-A) | A link needs External Offers (EEA) or the **billing choice program** (EEA and UK since 2026-06-30): Play Billing must still be offered alongside, 20% on one-time purchases from new installs, reporting within 24 h, refund/support obligations (Play Console Help 17161464). Google Play Billing in these regions carries service fee plus 5% billing fee (Help 112622). |
| Android **`play`**, **Japan / Australia** | **Play Billing** | Billing choice program from 2026-09-30, same obligations. |
| Android **`play`**, **elsewhere** | **Play Billing** | Payments policy §4: apps may not lead users to a payment method other than Play Billing outside a program (Help 9858738). Consumption-only apps may only say where to buy, without a link (Help 10281818), which is not a functional Buy (D17). |
| Desktop (Tauri; macOS, Windows, Linux) | **Website** | Not distributed through a store that governs payment (no Mac App Store or Microsoft Store build exists today; re-check if one is ever added). |
| Web | none shipped | `openExternalUrl` falls back to `window.open` only for the dev server; if a web client ever ships: Website. |

Decisions for @justin (costs as read 2026-10-16; figures from Google's help pages conflict between
pages and secondary summaries, so confirm in Play Console before deciding):

- **D-A, Google Play where a link is only possible through a paid program (US, EEA, UK, later Japan/Australia).**
  (a) Enroll and link out: US External Content Links, EEA/UK billing choice or External Offers. Cost:
  the program fee (about 20% of a one-time purchase made within 24 h of the tap in the sources
  read; 10-20% listed for US), plus the program's API integration and per-transaction reporting
  into the `play` flavor, refund/support/dispute obligations, and, for EEA/UK, **Play Billing
  still has to be built** because the choice must be offered. (b) Use Play Billing there: service
  fee plus 5% billing fee as listed for US/EEA/UK on Google's fee page (20% + 5% for new installs on the
  page as fetched; a secondary summary says 10% on the first $1M; rest of world 15% on the first
  $1M). The saving from (a) is at most the 5% billing fee, against an extra integration and
  reporting duty, and Play Billing has to exist anyway for the rest of the world.
  **Recommend (b) everywhere on `play` for v1**; revisit the US only after Google settles
  whether an un-enrolled link is acceptable and what ECL really costs after 2026-12-01.
- **D-B, Apple EU / Japan / Brazil.** (a) Apply for the link entitlement: about the same commission
  as IAP, plus disclosure sheet, monthly reporting, self-remitted tax, parental gate rules, and in
  Japan an IAP twin anyway. (b) StoreKit IAP. **Recommend (b).**
- **D-C, US iOS and guideline 3.1.3(b).** The US storefront shows Buy to the website, as decided.
  Guideline 3.1.3(b) legitimises a key field because the thing is "also available as in-app
  purchase"; in the US the argument rests on 3.1.1(a) instead. Keep the StoreKit product, Restore
  Purchases and the verifier live in the US build (they are the same binary). If App Review
  objects, the fallback is a secondary "Buy in the App Store" button in the US, not a rewrite.
  **Recommend: ship as decided; put the 3.1.1(a) argument in the review notes.**
