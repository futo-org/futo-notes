### Phase 3 — Rust and TS contract: the key — DONE 2026-09-16

The stored key now crosses every boundary on the view record, so no shell reads
it back out of its own storage for display.

- `apps/tauri/src-tauri/src/license.rs` — `LicenseView` gains `pub key:
  Option<String>` (serialized as `key`; the record is `camelCase`, and a
  one-word field is its own camelCase). Filled in `view_of` from
  `details.key.clone()` for both Licensed and Expired, and `None` in
  `unlicensed_view()`. That covers all four build sites the plan listed for
  free: the status read (`current_view`), `license_enter_key` (`accept_input` →
  `view_of`), `license_remove` (→ `unlicensed_view`) and the pending-link drain
  (the parked result was built by `accept_input`).
- `crates/futo-notes-ffi/src/license/contract.rs` — the UniFFI `LicenseView`
  gains `pub key: Option<String>`, filled the same way in its `view_of`.
  **Deviation from §4, deliberate:** the plan said `license_evaluate` fills it
  from `stored.map(|p| p.key)`. It does not — it fills it from
  `LicenseDetails::key`, which is the crate's *normalized* key. `stored.map(…)`
  would have handed back the raw stored string for a pair that no longer
  verifies, i.e. a key on an **Unlicensed** view (a release build reading a
  staging license, M3), contradicting "`None` when Unlicensed" in the same
  paragraph. Using `details.key` also makes the key identical on the evaluate,
  enter-key and deep-link paths instead of only the first.
- `src/lib/platform/license.ts` — `LicenseView.key: string | null`, and
  `UNLICENSED` gets `key: null`. **The TS field is `key`.** No change was needed
  in `src/lib/platform/tauri/license.ts`: it only `invoke`s and casts, and
  asserts no shape. There is no contract test for it (the platform contract
  tests are `adapter.contract.test.ts` / `imageRendering.contract.test.ts`;
  neither touches license).
- `crates/futo-notes-license` untouched; no rule changed, no golden moved.

Tests (each written red first, then made green):

- `a_licensed_state_carries_the_normalized_key` and
  `an_unlicensed_view_carries_no_key` in `license.rs` — the suite is 17 tests
  now (15 before).
- `a_licensed_view_carries_the_normalized_key` (stores `"  <key lowercased>  "`
  and asserts the view carries the trimmed, uppercased form),
  `an_expired_view_keeps_its_key`, and `an_unlicensed_view_carries_no_key`
  (nothing stored, and a staging pair read by a release bundle id) in
  `contract.rs` — that lib is 32 tests now (29 before).

Commands:

```
cargo test -p futo-notes-tauri license   → ok. 17 passed; 0 failed (exit 0)
cargo test -p futo-notes-ffi             → ok. 32 + 8 + 4 + 3 passed; 0 failed (exit 0)
just test-rust-full                      → exit 0, 27 "test result: ok" lines, 0 failures
just check-command-reachability          → OK — 46 registered commands, 0 allowlisted dead (exit 0)
just check-platform-discipline           → OK — 10 allowlisted OS-glue files, 0 unsanctioned imports (exit 0)
just rust-format-check                   → exit 0 (after `cargo fmt --all`)
pnpm exec tsc --noEmit                   → exit 0
pnpm run check:svelte                    → 0 errors, 0 warnings (exit 0)
vitest run src/features/license src/lib/platform → 167 passed (exit 0)
```

What Phases 4 and 5 must know:

- **Bindings must be regenerated before any native build** (M9): `just
  build-rust-ios` / `just build-rust-android`. They are gitignored, so nothing
  in git changed for them.
- **Two native construction sites will stop compiling once the bindings are
  regenerated**, both owned by the Phase 2 copy lane, so this phase left them
  alone as briefed: `apps/ios/Tests/License/LicenseCopyTests.swift:17`
  (`LicenseView(status:issuedAtMillis:expiresAtMillis:)`) and
  `apps/android/app/src/androidTest/java/com/futo/notes/license/LicenseCopyTest.kt`
  (five `LicenseView(LicenseStatus.…, …, …)` calls). They each need the new
  `key` argument. Nothing in `Sources/`/`main/` constructs the record — every
  other native site only reads fields — so no production Swift or Kotlin
  changed.
- **Two TypeScript fixture literals are now structurally incomplete** and no
  gate catches it, because `tsconfig.json` excludes `src/**/*.test.ts`:
  `src/features/license/licenseCopy.test.ts` (4 `LicenseView` literals) and
  `src/features/license/license.svelte.test.ts` (2). `tsc`, `svelte-check`,
  `eslint` and `vitest` are all green as they stand; add `key` when those files
  are rewritten in Phases 2 and 4.
- The key arrives **already normalized** (trimmed, uppercased) on every
  platform, so a card that masks it to its last group can slice the string
  as-is. It is `null` — never `""` — when there is nothing to show.
