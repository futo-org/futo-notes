## Android — IME

- Backspace on an empty note must not crash the WebView renderer. _(Android)_
  - _History (resolved):_ Chromium 147's empty-editable surrounding-text path
    tripped a `CHECK()` (`SIGTRAP`) when FUTO Keyboard queried it on backspace.
    This was **fixed upstream by a FUTO Keyboard update**, so the in-app IME
    shield is no longer required.
  - The in-app IME shield has been **removed** from the shared editor
    (`imeShieldPlugin` / `imeShield.ts`) and the `just verify-ime-shield` guard
    is gone. The native Compose app never carried it and is fine without it.
    (The `FutoImeConnection` / `EditorImeShield` Kotlin classes only ever lived
    in the gitignored generated Tauri-Android tree, which is no longer generated,
    and the `WRY_RUSTWEBVIEW_CLASS_EXTENSION` override that injected them is gone
    from `apps/tauri/src-tauri/.cargo/config.toml`.)
- Typing must be free of IME/caret glitches on every WebView the editor runs in.
  _(Android)_
