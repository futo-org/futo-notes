## Android — IME

- The native editor exposes an Android input connection backed by the Rust editor session; selection and replacement ranges use the current display's UTF-16 coordinates. → apps/android/app/src/main/java/com/futo/notes/textfirst/EngineInputConnection.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/EngineImeState.kt
- Composition, correction, deletion, selection and Undo preserve source ownership and the native selection, including emoji and table-cell input. → apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstExitTest.kt, apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTableTest.kt
- Backspace on an empty note is safe. Native keyboard handling does not depend on a WebView renderer or its surrounding-text implementation. → apps/android/app/src/main/java/com/futo/notes/textfirst/EngineInputConnection.kt

The shared input contract is [interpretation and input](portable-core/interpretation-and-input.md); clipboard behavior is in [mobile clipboard](mobile/clipboard.md).
