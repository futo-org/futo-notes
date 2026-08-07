# apps/ios — native SwiftUI shell

Read root `AGENTS.md` first. This is the shipping iOS app over `futo-notes-ffi` with the embedded
web editor; there is no Tauri mobile shell.

The Xcode project comes from `project.yml`. UniFFI bindings and generated editor contracts are
generated—edit the project/config or source manifest, never their output.

## Build and test

- Simulator/device: `just ios-native` / `just ios-native-device`.
- Compile/test: `just build-ios-native` / `just test-ios-native` (requires a booted simulator).
- Release device install: `just deploy-ios`.
- After an FFI-visible Rust change, rebuild with `just build-rust-ios`; direct Xcode does not.

## Constraints

- **CRITICAL:** Debug uses `com.futo.notes.dev` + `fake-notes` under `#if FUTO_DEBUG_BUILD`; release
  uses `com.futo.notes` + `futo-notes`. Never let debug touch production notes.
- Note rules belong in Rust. Swift projects the FFI facade rather than reimplementing domain logic.
- Vault I/O stays behind the `NoteVault` actor; `hasBootstrapped` distinguishes loading from empty
  so first render never waits on I/O.
- `Sources/Editor/EditorWebView.swift` is the hand-written bridge host. New messages also require
  the Android host; `packages/editor/src/bridge.ts` is authoritative.

Tests live under `apps/ios/Tests/`. Device/simulator QA is still required for changed flows;
keyboard, safe-area, or scroll work exercises new/existing notes, toolbar, and scroll-during-IME.
Drive and diagnose through `/verify`; synthetic iOS gestures can report false success (M21).
