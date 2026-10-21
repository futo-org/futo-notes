## Proposal per bucket

Vocabulary rules kept: no "paywall", "premium", "free", "donate"; "unlock(s)" only on link-out
builds; "included with a license" / "comes with a license" elsewhere. Placeholders use the
catalog's `{name}` grammar. The website address is a placeholder filled from Rust config, so it is
environment-split (staging vs production, the M3 rule) and never written into a translation.

### iOS US storefront — keep link-out, no copy change (risk: medium)

The steering side is clean (3.1.1(a) US exemption). The medium rating is the off-the-record report
that Apple wants IAP alongside a US link, plus the 3.1.1 key clause covered below. Keep Buy opening
in Safari/the default browser, never an in-app browser. No copy change.

### iOS every other storefront — stay key-only; reword to point at the key, never at a seller (risk: low for steering)

Do not name the website, FUTO's shop, a price, or "sold elsewhere" anywhere on these storefronts.
"Licenses are sold by FUTO" is still an encouragement to buy outside IAP under 3.1.3, so it is out.
The App Store product page is the same text for every storefront that shares a localization, so it
must not mention buying on the website either (3.1.1(a) says "apps and their metadata").

| Key | Text | Status |
|---|---|---|
| `license.keyOnlyExplanation` | Have a FUTO Notes license? Enter your key to activate it on this device. | Keep as is. Already at the line. |
| `settings.appIcon.license.footnoteKeyOnly` | Choosing an app icon is included with a FUTO Notes license. | Keep as is. |
| `settings.appIcon.license.sheetBodyKeyOnly` (new) | Choosing an app icon is included with a FUTO Notes license. If you have one, enter your key to activate it on this device. | New, replaces reusing `license.keyOnlyExplanation` as the sheet body, so the sheet says what it is about. Low steering risk: it points to activation, not purchase. |
| `license.lostKey` on key-only | (existing text "Lost your key?", opens `mailto:support@futo.tech`) | Optional, **medium**. A support contact is not a purchase path, but a reviewer may read "your key" plus a FUTO address as a route to the seller. Only add it after one key-only build has passed review. |

### Android `play`, every region — new "name the website" surface (risk: low)

This is the change worth making. The card keeps the key field and deep link, gains the payment
headline and a sentence that names the website as plain, non-tappable text. Conditions that keep it
low risk: the address is not a link (no `autoLink`, no `Linkify`, no click handler, no "Copy"
button, no QR code); no Buy button; no price; the Play listing may say the same thing in words.

| Key | Text | Notes |
|---|---|---|
| `license.unlicensedHeadline` | Pay for FUTO Notes | Existing key, now shown on `play` too. Google's own consumption-only examples are stronger than this. |
| `license.explanation` | FUTO Notes is paid for by you, not by ads or by selling your data. | Existing key, now shown on `play` too. |
| `license.websiteExplanation` (new) | Licenses are sold on FUTO's website at {url}. Already bought one? Enter your key to activate it on this device. | `{url}` is a short, typeable address (see unknowns). Rendered as plain text. |
| `settings.appIcon.license.footnoteWebsite` (new) | Choosing an app icon is included with a FUTO Notes license, sold on FUTO's website. | Replaces `footnoteKeyOnly` on `play` only. |
| `settings.appIcon.license.sheetBodyWebsite` (new) | Choosing an app icon is included with a FUTO Notes license. Licenses are sold on FUTO's website at {url}. Already bought one? Enter your key in Settings. | Sheet actions: `license.enterKey` ("I already paid") and `settings.appIcon.license.notNow`. |
| `license.lostKey` | Lost your key? | Show on `play` (opens the support mailto). Google allows referring to help or account information that does not lead to payment. Low. |

Rejected as too far for `play`: a Buy button that copies the address, a QR code, a tappable
address, a price, and the word "unlocks" (allowed by Google, but the repo rule ties "unlock" to
link-out builds; Justin's call to relax it).

### Android `play`, US — do not flip to link-out (risk if flipped un-enrolled: high)

Reasons: (1) Google's program page requires enrollment before using links, and says nothing about
un-enrolled US links; (2) enrolling costs 10–20% per linked sale, reporting, refund duties and
the Play Billing Library, which breaks "no commission program"; (3) the `play` build has no way to
know the user is in the US without Play Billing's country lookup, and a wrong guess is a policy
violation outside the US; (4) the injunction is temporary (roughly to late 2027, unconfirmed) and
under active litigation. The "name the website" surface above gets most of the value with none of
this.

### Desktop and Android `direct` — unchanged link-out (risk: none from stores)
