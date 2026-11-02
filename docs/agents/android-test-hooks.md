# Debug-only automation hooks

`app/src/debug/java/com/futo/notes/testhook/` registers a broadcast-driven command
surface: the Android counterpart of the desktop `window.__testSync` hook. It
exists because an accessibility dump costs ~2s and shows what Compose last
managed to render, not what the app holds (M21) — so a test that taps through a
multi-step flow is both slow and unreliable.

Adding a hook is a few lines in `MainActivity.testHooks()` (`MainActivityTestHooks.kt`):

```kotlin
"confirm-storage" to {
    val adoption = checkNotNull(pendingStorageAdoption.value) {
        "no storage switch is awaiting confirmation"
    }
    pendingStorageAdoption.value = null
    adoptExistingStorage(adoption)
    null            // or a Map<String, Any?> of fields to report back
}
```

Rules:

- **A hook calls an entry point the UI already calls.** It must not contain
  behavior of its own, or the test stops testing the app.
- **Throw on a bad argument.** The ack carries the reason; a silent no-op looks
  exactly like a hung flow.
- **Return fields rather than logging them.** They travel back on the ack line,
  which is what makes one round-trip enough.
- **Never widen `main` to serve a hook.** If a hook needs state, it reads it in
  `MainActivity`, where it already lives.
- **Debug source set only.** A release build compiles the no-op sibling, so the
  release APK carries none of this — do not "simplify" that back into a
  `BuildConfig.DEBUG` branch in `main`, which would leave a shell-reachable way to
  move the user's notes in the shipped source and rely on R8 to drop it. The two
  `TestHooks` signatures must match; a mismatch fails the release compile, which
  is when you want to hear about it.

The `state` hook's field names are read by `tests/lib/android/testHooks.mjs`
(`STATE_FIELDS`) with nothing linking them at compile time. That is deliberate —
adding a field to `main` for a test-only type would be worse — and it fails loud:
`parseStateAck` throws naming any field that went missing. Change one side, change
the other.
