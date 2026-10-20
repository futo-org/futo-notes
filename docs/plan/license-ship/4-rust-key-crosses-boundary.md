## 4. Rust: the key crosses the boundary

Both `LicenseView` records gain the stored key so every shell reads it from the same place (there is no desktop route to it otherwise, and iOS/Android should not reach past the contract into their own storage for display):

- `apps/tauri/src-tauri/src/license.rs` — `pub struct LicenseView { …, pub key: Option<String> }`, `None` when Unlicensed. Populate it wherever a `LicenseView` is built from a stored pair (the status read, `license_enter_key`, `license_remove` → `None`, the pending-link drain). Extend the existing lib tests: `cargo test -p futo-notes-tauri license` (15 tests today) must cover "the view carries the normalized key when licensed and nothing when not".
- `crates/futo-notes-ffi/src/license/contract.rs` — `pub struct LicenseView { …, pub key: Option<String> }` and `license_evaluate` fills it from `stored.map(|p| p.key)`. Add a contract test beside the 29 existing ones. Rebuild bindings before native work (`just build-rust-ios`, `just build-rust-android`; M9).
- `src/lib/platform/license.ts` — `LicenseView.key: string | null`; `UNLICENSED` gets `key: null`. Update `src/lib/platform/tauri/license.ts` and its contract test if it asserts the shape.
- No license **rule** changes. `futo-notes-license` itself is untouched; `just test-rust` still passes with the goldens as they are.

This is an IPC record change, not an `AppState` schema or sync payload change, so it does not fall under root AGENTS.md §11 item 6.
