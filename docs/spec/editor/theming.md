## Theming

- The editor follows the app theme. Desktop applies `data-theme` to its web editor. Native mobile updates its view and Rust-provided style plan from the platform color scheme. → src/styles/theme.css, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Style.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/SpanPlan.kt
- Native editor backgrounds and keyboard toolbars use the app's theme colors in light and dark modes. → apps/ios/Sources/Editor/Toolbar/EditorToolbarAccessory.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- Mobile editor availability is independent of the installed System WebView provider. There is no capability probe, update-WebView notice or web-renderer fallback. → native-host-boot.md
- The standalone web fixture retains its browser syntax floor, preflight and compatibility shims for browser regression testing. → editor.html, tests/editor-embed-webview-floor.spec.ts, tests/editor-embed-webview-floor-css.spec.ts
