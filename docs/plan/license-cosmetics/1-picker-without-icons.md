## 1. The picker when the license does not include icons (M2, M3)

Concept A (D11), `license-cosmetics/02-picker-unlicensed.png`. The resting picker is unchanged in
shape: two-column grid, six labeled tiles, the current choice checked.

- Every tile except the current one wears a small coin badge (the existing
  `SupporterCoin` artwork, 26pt, bottom-trailing of the artwork, surface-colored ring).
  Tiles are **not** dimmed and **not** disabled: a cosmetic should look like what it is.
- A footnote under the grid: `settings.appIcon.license.footnote`.
- Tapping a badged tile opens a sheet over the picker (iOS: `.sheet` with a medium detent;
  Android: a second `ModalBottomSheet`): the tapped icon's artwork with the coin badge, the
  title `settings.appIcon.license.sheetTitle`, one paragraph, one filled button, text links.
  - Link-out: paragraph `settings.appIcon.license.sheetBody`; filled **Buy a license**
    (`license.buy`, or `license.renew` when Expired) → opens the Buy URL with
    `from=app-icon` (M4) exactly the way the License card opens it today (default browser
    on iOS, Custom Tab on Android `direct`); links **I already paid** (`license.enterKey`)
    → dismisses the sheet and the picker, scrolls Settings to the License card, opens the key
    field; **Not now** (`settings.appIcon.license.notNow`) → back to the grid.
  - Key-only: paragraph `license.keyOnlyExplanation`; filled **I already paid**; link **Not
    now**. No other control, no other copy.
  - Which shape is Rust's answer: reuse `license_row_actions(status, link_out)` — if it
    contains `Buy`/`Renew` the sheet is link-out, else key-only. No new storefront logic.
- Tapping the current tile is a no-op, as today.
- The Settings row gains a trailing coin + `settings.appIcon.license.rowHint` before the
  chevron while the license does not include icons (`01-settings-row-hint.png`). The License
  card itself does not change (D12).
- The sheet is `03-tap-sheet.png`, both builds.
- Licensed (D13, right half of `04-after-activation.png`): the footnote, the sheet and the row
  hint disappear; the coin badge stays on every tile but Standard. Tapping a tile changes the
  icon exactly as today.
