### Phase 2 — copy and view-model — DONE 2026-09-16

The one-line `licenseRowText` is gone from all three shells; each now builds the
same five-field card model. Catalog, three view-models, three test locks and the
drift entry moved in one commit (M7, M17).

**Catalog as shipped** (`languages/en.json`, `messages.license`). Removed:
`licensed`, `licensedPerpetual`, `licensedUndated`, `expired`, `supporterSince`.
Changed: `explanationLicensed` → "Thank you for paying for FUTO Notes." Added:
`statusLicensed` "Licensed", `statusExpired` "Expired", `licensedSince`
"Licensed since {date}", and the `license.card.*` group exactly as §2 lists it
(`eyebrow`, `productName`, `keyLabel`, `sinceLabel`, `termLabel`,
`termPerpetual`, `termValidUntil`, `termExpired`, `revealKey`, `copyKey`,
`keyCopied`, `emptyWell`). `zh-Hans.json` has no `license` group at all, so
nothing to remove there. `pnpm run check:languages` validates catalogs only — it
never looks at call sites, so an entry Phases 4/5 have not wired up yet is fine.

**The model, per platform** (same five fields, same rules, platform-idiomatic
types):

| | desktop | iOS | Android |
|---|---|---|---|
| type | `interface LicenseCardModel` | `struct LicenseCardModel: Equatable` | `data class LicenseCardModel` |
| entry point | `licenseCardModel(view)` | `licenseCardModel(_ view:_ localization:)` | `licenseCardModel(view, localization)` |
| `status` | `LicenseStateName` | `LicenseStatus` | `LicenseStatus` |
| `badge` | `string \| null` | `String?` | `String?` |
| `since` | `string \| null` | `String?` | `String?` |
| `term` | `string` | `String` | `String` |
| `maskedKey` | `string \| null` | `String?` | `String?` |

`licenseAmbientLabel` stays desktop-only (the footer) and now reads
`license.licensedSince` with `localizedAbsoluteDate(issuedAt)` — full date, D3.
The native shells have no ambient label and gained none.

**Decisions the plan left open, taken here:**

- **`term` for Unlicensed is the empty string.** §3 types it non-null and lists
  only three licensed-ish values; an unlicensed device has no term, and
  "Perpetual" there would be a claim. The row renders blank exactly as the
  `since` row does under D2. Locked by a test on all three platforms.
- **The Expired-without-dates guard returns the *whole* Unlicensed card**
  (badge "Unlicensed", `since` null, `term` "", `maskedKey` null), not a
  half-built expired one. Identical on all three platforms and asserted by
  equality against the unlicensed model on iOS/Android.
- **The mask is built in code, not from a catalog entry**: it formats user data
  (the key), like a date. `7 × "····"` (four U+00B7 MIDDLE DOT) joined with
  single spaces, then `key.slice(-4)` / `key.suffix(4)` / `key.takeLast(4)` —
  `···· ···· ···· ···· ···· ···· ···· 6UJV`. Constants are private to each copy
  (`MASK_GROUP` / `licenseMaskGroup`, `MASKED_GROUPS` = 7,
  `LAST_GROUP_LENGTH` = 4). It never re-groups or re-cases the key: Phase 3
  guarantees it arrives normalized and `null`-never-`""`.

**Call sites touched that the plan did not predict** — all minimal,
keep-it-building edits, no restyling; Phases 4 and 5 own the real card:

- `src/features/license/LicenseSettingsSection.svelte` — imports
  `licenseCardModel` instead of `licenseRowText`; the status line renders
  `licenseCardModel(license.view).badge ?? localizedText('license.statusLicensed')`.
- `apps/ios/Sources/License/LicenseSettingsSection.swift` — same substitution,
  `accessibilityIdentifier("license-status")` unchanged.
- `apps/android/.../ui/LicenseSettingsSection.kt` — same substitution inside the
  existing `SettingsRow`.
- `src/lib/platform/license.ts`, `src/shared/localization/localization.ts` +
  `.test.ts`, `apps/ios/Sources/Localization/Localization.swift`,
  `apps/android/.../localization/Localization.kt` +
  `AndroidLocalizationRules.kt` — doc comments that cited "Supporter since
  {year}" (M17). **`localizedYear` now has no production caller on any
  platform**; it was left in place (it is a three-platform API with its own
  localization tests) and its comments no longer cite removed copy. Removing it
  is a separate decision for Phase 6 if anyone wants it.
- The four TS and five Kotlin/Swift `LicenseView` construction sites Phase 3
  flagged all carry `key` now: `licenseCopy.test.ts` (rewritten),
  `license.svelte.test.ts` (2 literals + the `UNLICENSED` mock),
  `LicenseCopyTests.swift`, `LicenseCopyTest.kt`.

**Drift registry**: `license-row-copy` → `license-card-copy`; description, the
three `copies[].pattern`s and the `scan.pattern` all point at
`licenseCardModel`; `lockStatus: partial` and the same three locks kept, with
the note rewritten to say what is and is not pinned (the five-field model and
the identical guard/mask are; byte-identical output is not, because the three
date formatters legitimately differ).

**Commands and results:**

```
pnpm run check:languages       → Validated 2 language catalogs. (exit 0)
just test-one src/features/license → 2 files, 32 tests passed (exit 0)
just check-drift               → OK — 17 concepts (7 locked, 5 partial, 5 unlocked) (exit 0)
just test-ios-native           → ** TEST SUCCEEDED ** — 166 tests in 29 suites,
                                 incl. all 7 "License copy" cases (exit 0)
just test-android-native-ui    → 43 tests, 1 failure (exit 1) — see below
just test-android-native       → BUILD SUCCESSFUL, both flavors (exit 0)
pnpm run lint                  → 0 errors, 4 pre-existing warnings (exit 0)
pnpm run format:check          → all files formatted (exit 0)
pnpm exec tsc --noEmit         → exit 0
pnpm run check:svelte          → 0 errors, 0 warnings (exit 0)
xcrun swift-format lint --strict (the three changed Swift files) → exit 0
```

**The one Android red is NOT this work.** `just test-android-native-ui` fails on
`com.futo.notes.ui.components.DialogImeDismissTest >
dialogFieldKeepsFocusAndKeyboardWhileImeShows`: "activity window never saw the
ime insets". All seven `LicenseCopyTest` cases pass in the same run. That
assertion is gated `if (Build.VERSION.SDK_INT >= 35)` and the pooled AVD
`just qa-claim android` hands out here is **API 36 / Android 16**, while the
test was written against CI's API 34 AVD where the branch is skipped — so on
this host the app really does not receive activity-window ime insets while a
dialog field owns the keyboard, which is either an Android 16 behavior change or
a genuine gap in the github#23 fix. It is a Compose-only test that constructs
its own `Dialog` + `OutlinedTextField` and never touches license code. A clean
control run was **impossible**: at `HEAD~1` the androidTest sources do not
compile at all, because Phase 3 deliberately left `LicenseCopyTest.kt`'s five
`LicenseView(...)` calls missing the new `key` argument — so there was no green
baseline on this branch to regress from. **Phase 5 and Phase 7 will hit this on
every API-36 pool device; it needs its own diagnosis and is not a license bug.**

**What Phases 4–6 must know:**

- `licenseRowText` no longer exists anywhere. Render from `licenseCardModel`;
  the three status-line call sites above are placeholders showing only `badge`
  and are meant to be replaced wholesale by the plate.
- The Licensed state has **no badge** (`badge == null`) — the coin in the well
  is the statement. A shell that wants the word "Licensed" reads
  `license.statusLicensed`.
- `since` is `null` for every v1 activation (D2). Render the row and leave the
  value empty; never substitute.
- Catalog entries added but **not yet used by any shell**:
  `license.card.eyebrow`, `productName`, `keyLabel`, `sinceLabel`, `termLabel`,
  `revealKey`, `copyKey`, `keyCopied`, `emptyWell`. Phases 4/5 wire them up.
- **Left deliberately untouched, still saying "Supporter since"** (each is
  another phase's file, per this phase's brief): `docs/spec/license.md`,
  `docs/spec/localization.md:238`, `docs/release/store-submission.md:17`,
  `crates/futo-notes-license/AGENTS.md:7`,
  `apps/tauri/src-tauri/src/license.rs` (4 doc comments),
  `src/features/license/SidebarLicenseFooter.svelte` (2 comments, lines 23 and
  74 — Phase 4 owns that file). `docs/spec/list.md`'s footer line WAS corrected
  here, to "Unlicensed" or "Licensed since {date}" and without the stale
  "beside the app version". Phase 6 should re-run
  `rg -n "Supporter since|licensedPerpetual|licensedUndated|supporterSince" .`
  and expect only its own historical verification paragraphs to remain.
