## 2. M1 — the Rust rule and its projections

`crates/futo-notes-license`:

```rust
/// What a license includes beyond the card. Cosmetic only, by policy (D1, license.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseInclusion { AppIcon }

/// The one place the policy lives. Licensed → everything; Unlicensed and Expired → nothing.
pub fn license_includes(status: LicenseStatus) -> Vec<LicenseInclusion>
```

- Tests: Licensed includes `AppIcon`; Unlicensed and Expired include nothing; the list is
  stable (snapshot) so adding a variant is a deliberate edit.
- `futo-notes-ffi` license contract: export `license_includes` and `LicenseInclusion` as a
  `uniffi::Enum`, next to `license_row_actions`. Contract test mirrors the Rust one.
- Tauri: `includes` rides on the `LicenseView` the existing license commands already return
  (computed in Rust through `license_includes`, off `LicenseState::status()`); TS reads it
  from the view, no second IPC call. Desktop renders nothing from it yet.
- Shells: `LicenseModel` (Swift/Kotlin) exposes `includes: Set<LicenseInclusion>` derived from
  `view.status` through the FFI call, updated wherever `view` is assigned (load, apply,
  remove, full reset). `AppIconController` does **not** learn about licenses; the picker view
  reads `license.includes.contains(.appIcon)` and branches between the two renderings. Keep
  the icon-change mechanics (`select`, confirm dialog, readback) untouched.
- Rewrite the policy text: `docs/spec/license.md` § Principles ("Nothing is gated" → "Nothing
  that works is gated" + the inclusion rule), line 4 of the same file, line 637's copy claim,
  `crates/futo-notes-license/AGENTS.md:9`, `crates/futo-notes-license/src/lib.rs:4`,
  `apps/ios/Sources/License/LicenseSettingsSection.swift:83`,
  `src/features/license/LicenseSettingsSection.svelte:9`, `docs/plan/license-ship.md:278`.
  Add `docs/adr/0006-a-license-may-include-cosmetics.md`.
- Spec: new lines in `docs/spec/license.md` (a "What a license includes" section, platform
  tagged) and `docs/spec/settings.md` § Native app icons (the unlicensed rendering, the sheet,
  the row hint, D2, D3). `settings-visual.md` § Native app icon picker gets the badge and
  sheet geometry.

Verification: `cargo test -p futo-notes-license -p futo-notes-ffi`, `just check`.
