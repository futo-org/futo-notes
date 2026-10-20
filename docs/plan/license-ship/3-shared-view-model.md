## 3. The shared view-model (drift-registered)

The three shells today share the concept `license-row-copy` in `scripts/drift-registry.json` (`licenseRowText` in `src/features/license/licenseCopy.ts`, `apps/ios/Sources/License/LicenseCopy.swift`, `apps/android/.../license/LicenseCopy.kt`, locked by `licenseCopy.test.ts`, `LicenseCopyTests.swift`, `LicenseCopyTest.kt`). The card replaces the one-line row with a small structure. Rename the concept to `license-card-copy` and give every copy the same shape:

```
licenseCardModel(view) -> {
  status:  'unlicensed' | 'licensed' | 'expired'   // already judged by Rust; never re-derived
  badge:   string | null      // Unlicensed → license.unlicensed; Expired → license.statusExpired; Licensed → null
  since:   string | null      // full localized date of issued_at, or null (row renders blank)
  term:    string             // termPerpetual | termValidUntil{date} | termExpired{date}
  maskedKey: string | null    // '···· … XXXX' from the stored key, null when no license
}
licenseAmbientLabel(view) -> string | null   // desktop footer: license.unlicensed, license.licensedSince{date}, or null for a v1 license (unchanged rule)
```

Rules (unchanged from the spec, restated so nobody re-derives them):

- `since` is null whenever `issued_at` is absent. No stand-in, no fetch time, no current year.
- `term` for a v1 activation is `termPerpetual`.
- Expired always has both dates; keep the existing guard that falls back to Unlicensed if it ever arrives without them (the "Supporter since NaN" guard).
- Whether the state is licensed/expired/unlicensed is Rust's answer (`LicenseView.state` / `LicenseStatus`). The model formats; it never judges.

Update the drift-registry entry's `concept`, `description`, `copies[].pattern` (new function names) and keep `lockStatus: partial` with the same three test locks. `just check-drift` must pass.
