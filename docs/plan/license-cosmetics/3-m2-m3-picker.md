## 3. M2 iOS, M3 Android — the picker

- iOS: `AppIconPicker.swift` grows the badge (both states, D13), the footnote and the sheet
  (unlicensed only); `SettingsView.swift` the row hint. `LicenseSettingsSection.swift` is
  untouched (D12). Tests: `AppIconPickerTests` (rendering per status, which is a pure function
  of `includes` + `rowActions`), a UI test in `AppIconTests` that taps a badged tile on a
  forced-Unlicensed build and sees the sheet, then forces Licensed and sees the grid with
  badges and no footnote. Storefront forcing already exists (`-FUTOLicenseStorefront`).
- Android: `AppIconSheet.kt` the same; `SettingsScreen.kt` the row hint;
  `LicenseSettingsSection.kt` untouched. Tests: `AppIconSheetTest` (Compose, both renderings,
  both flavors). The existing "Change app icon to …?" confirm stays after the license check,
  untouched. Android sketch: `05-android-and-second-device.png`, left.
- Accessibility: a badged tile's label becomes "{name}, included with a license"
  (`settings.appIcon.license.a11yIncluded`); the sheet's title is its heading.
- Catalog: every string in § 6, English only, `pnpm run check:languages`.

Verification: `just ios-native` + the suites above; `just android-native` on both flavors +
`AppIconSheetTest`; a device pass on each per `apps/*/AGENTS.md` with screenshots of the four
renderings (unlicensed link-out, unlicensed key-only, sheet, licensed).
