# FUTO Notes — Native iOS

The iOS app is a native SwiftUI shell over the shared Rust note and sync
engines. The Markdown editor is the same CodeMirror bundle used by desktop and
Android, embedded in a `WKWebView`.

This app does not use Tauri. Generate, build, test, and run it through the
repository-root `just` recipes so the editor bundle, UniFFI bindings, isolated
simulator selection, and debug data guards are applied consistently.

```bash
just build-ios-native
just test-ios-native
just ios-native
```

## Ownership

Production code is grouped by the capability that owns it:

```text
Sources/
  App/                 app composition, launch isolation, theme, full reset
  CrashReporting/      crash capture, persistence, upload, and report sheet
  Editor/              shared WebView host, bridge, draft/navigation gates
    GeneratedContracts/ generated bridge, title, and toolbar contracts
    Images/             native image loading, picking, and vault persistence
    Toolbar/            keyboard accessory toolbar
  Notes/
    Editor/             open-note editing lifecycle
    List/               list/folder presentation and destructive dialogs
    Storage/            thin Swift projection over the Rust local-note store
    Models.swift        iOS presentation records
  Settings/            native settings sheet
  Sync/                credential boundary, SyncClient driver, and sync sheet
  Generated/           generated UniFFI bindings (gitignored)
```

Tests mirror these owners under `Tests/`. Launch-level XCTest coverage lives in
`UITests/`; each run gets an isolated notes root, search directory, and Keychain
service and does not restore the developer's sync session.

## Data and domain boundaries

- `futo-notes-store` owns note and folder workflows, ordered snapshots,
  position-bearing mutations, draft persistence/parking, and search.
- `futo-notes-sync` owns connect, push-first cycles, live sync, checkpoints,
  crypto, and conflict handling.
- Swift owns native presentation and lifecycle orchestration. It applies Rust
  mutations verbatim and never re-sorts or reconstructs note-domain workflows.
- Debug builds use `com.futo.notes.dev` and `Documents/fake-notes`; Release uses
  `com.futo.notes` and `Documents/futo-notes`.

Generated Swift contracts must be updated from their sources:

```bash
just bridge-spec
just toolbar-spec
just title-spec
just build-rust-ios
```

Do not edit `Sources/Generated/` or `Editor/GeneratedContracts/` directly.

## Editor bridge

`packages/editor/src/bridge.ts` is the versioned `futoBridge` source of truth.
`Editor/EditorWebView.swift` is the iOS host. The host renders native toolbar
and picker chrome, while editing behavior remains in the shared editor package.

The self-contained editor asset is built from `vite.editor.config.ts` into
`Resources/editor.html`; it is generated and gitignored.

## Project generation

`project.yml` is the Xcode source of truth. `xcodegen generate` produces
`FutoNotesNative.xcodeproj`, which is generated and must not be edited.

The application and unit-test host use ad-hoc signing on Simulator because the
Keychain entitlement is part of tested behavior. The UI-test bundle also
generates its Info.plist and is ad-hoc signed so XCTest can install and launch
it. Physical-device builds use the team configured by the root recipes.
