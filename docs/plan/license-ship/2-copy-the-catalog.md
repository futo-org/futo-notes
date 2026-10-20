## 2. Copy: the catalog after this plan

All in `languages/en.json` under `messages.license`. `zh-Hans.json` entries are welcome, not required. Run `pnpm run check:languages` after every catalog edit. Naming grammar: `languages/README.md`.

**Remove** (composite row strings that the card no longer renders):
`license.licensed`, `license.licensedPerpetual`, `license.licensedUndated`, `license.expired`, `license.supporterSince`.

**Keep unchanged:** `sectionTitle`, `explanation`, `unlicensed` ("Unlicensed"), `buy`, `renew`, `enterKey`, `lostKey`, `remove`, `keyLabel`, `keyPlaceholder`, `activate`, `activating`, `cancelEntry`, `openLicenseSettings`, `coinAccessibilityLabel`, `activated`, `keyInvalid`, `linkInvalid`, `offline`.

**Change:** `explanationLicensed` → `"Thank you for paying for FUTO Notes."`

**Add:**

| Key | English |
|---|---|
| `license.statusLicensed` | `Licensed` |
| `license.statusExpired` | `Expired` |
| `license.licensedSince` | `Licensed since {date}` (ambient footer label; `{date}` is the full localized date of `issued_at`) |
| `license.card.eyebrow` | `Client license` |
| `license.card.productName` | `FUTO Notes` |
| `license.card.keyLabel` | `Key` |
| `license.card.sinceLabel` | `Licensed since` |
| `license.card.termLabel` | `Term` |
| `license.card.termPerpetual` | `Perpetual` |
| `license.card.termValidUntil` | `Valid until {date}` |
| `license.card.termExpired` | `Expired {date}` |
| `license.card.revealKey` | `Show key` (accessible name of the masked value; it is a button) |
| `license.card.copyKey` | `Copy key` |
| `license.card.keyCopied` | `License key copied` (toast) |
| `license.card.emptyWell` | `No license` (accessibility label of the empty well when not Licensed) |

The word "donate" must not appear anywhere (spec § Principles). Nothing may call the app "free".
