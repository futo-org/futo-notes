# Faster Android iteration with coding agents

Researched 2026-11-04. Source review only; no builds, benchmarks, installs, or tool adoption.

## Most relevant reading

1. **[Compose HotSwan 2.0 release: the build tax agents did not fix](https://hotswan.dev/blog/compose-hotswan-2-0-release)** — Jaewoong Eum, September 12, 2026. This directly addresses agents producing changes faster than developers can build, reinstall, and navigate back to inspect them. Its interpreter permits structural Compose changes on a running Android app, including adding composables and replacing a screen. Treat the reported seconds-to-screen figures as vendor results, not measurements of FUTO Notes. The [October 2.2 release](https://hotswan.dev/blog) shows the implementation is still evolving rapidly.

2. **[HotSwan: hot reload with AI](https://hotswan.dev/docs/hot-reload-with-ai)** — specifically documents external CLI agent edits: periodic filesystem refresh detects files saved outside the IDE, debounces bursts, compiles changed code, and updates the device. Android Studio or IntelliJ must be running the instrumented app. Its [MCP bridge](https://hotswan.dev/docs/mcp-server) additionally exposes reload and screenshot tools. For this repo, existing `just puppet` remains the authorized device interaction interface; adopting another control interface would need deliberate integration.

   Caveats: this accelerates Kotlin/Compose changes, not Rust/JNI or the embedded web editor. The [limitations](https://hotswan.dev/docs/limitations) include rebuilding for some composition shape changes, inline functions, and named suspend-function bodies; new Android resources require reinstall, and class hierarchy changes restart the process. It is a commercial third-party plugin: [pricing](https://hotswan.dev/pricing) currently lists a 14-day trial, $5/month personal, and $15/month commercial. Compatibility and state preservation need a small representative evaluation before depending on it.

3. **[Google: Android CLI and skills — build Android apps 3x faster using any agent](https://developer.android.com/blog/posts/android-cli-build-android-apps-3x-faster-using-any-agent)** — April 16, 2026. Official, agent-neutral SDK/device/project automation, Android skills, and documentation access. The headline's 3x result concerns Google's internal **project and environment setup tasks**, with over 70% fewer tokens; it is not evidence of faster incremental app compilation or Rust builds. Useful for reducing agent tooling mistakes, less directly useful for this warm-build bottleneck.

4. **[Google: iterative Compose development / Live Edit](https://developer.android.com/develop/ui/compose/tooling/iterative-development)** — built-in Android option for updating function bodies on API 30+ debug devices. Adding functions, changing signatures, and class hierarchy edits require a full run; the first edit in a file resets state. Google's [implementation explanation](https://android-developers.googleblog.com/2023/07/deep-dive-into-live-edit-for-jetpack-compose-ui.html) describes IDE PSI change listeners. The cited documentation does not establish reliable detection of external CLI agent saves, so do not assume it is a drop-in agent file watcher without testing that path.

5. **[JetBrains: Compose Hot Reload](https://kotlinlang.org/docs/multiplatform/compose-hot-reload.html)** — currently requires a desktop JVM target; Android Studio support refers to the IDE, not an Android hot reload target. A desktop sandbox can help shared Compose UI, but FUTO Notes' desktop shell is Svelte/Tauri, so this would require extra architecture and would not validate Android-specific behavior.

## Applicability to this checkout

The cheapest immediate improvement appears to be choosing the existing build lane for the changed layer, before adding a hot reload system:

- For Kotlin-only edits in a warm checkout, [the Android manual](../../apps/android/AGENTS.md) already permits `./gradlew :app:installDirectDebug` from `apps/android`, avoiding a Rust/bindings rebuild. Bootstrap through `just android-native` first. Rust/FFI changes still require rebuilding Rust and bindings.
- [The Rust Android build script](../../scripts/build-rust-android.sh) already accepts `FUTO_ANDROID_FFI_PROFILE=dev` and device-only ABI selection. Its default `release-ffi` inherits the optimized release profile, while preserving UniFFI unwind support. A development profile is worth timing for Rust iteration; actual savings and runtime behavior have not been measured here.
- That script stages JNI outputs afresh, builds the host library, and regenerates Kotlin bindings each invocation. An input-aware warm path could avoid unnecessary work when inputs are unchanged, but must preserve the existing stale-binding and wrong-ABI guards. This is a possible follow-up, not a proposed weakening of M9.

Inference: HotSwan is the closest published answer for rapid **Compose UI** iteration with agents. For the combined Rust-plus-Android loop, avoiding unnecessary cross-layer builds is likely the first useful experiment; none of the hot reload sources claims to reload this project's native Rust core.
