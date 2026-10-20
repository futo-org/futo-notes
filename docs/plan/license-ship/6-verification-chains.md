## 6. Verification chains (what "done" means per layer)

| Layer | Chain |
|---|---|
| Catalog | `pnpm run check:languages` |
| Rust contract | `cargo test -p futo-notes-tauri license`, `cargo test -p futo-notes-ffi`, `just test-rust-full`, `just check-command-reachability` |
| Desktop UI | `just build`, `just test-one src/features/license`, `pnpm run test:e2e:smoke`, `tests/license-card.spec.ts`, `just check-theme-single-pace`, screenshots via the webview bridge |
| iOS | `just build-rust-ios`, `just test-ios-native`, `just lint-swift`, driven on the claimed simulator |
| Android | `just build-rust-android`, `just test-android-native`, `just test-android-native-ui`, driven on the claimed emulator, both flavors |
| Drift | `just check-drift` |
| Everything | `just check` before every push; `just prepush` before taking the MR out of Draft |
