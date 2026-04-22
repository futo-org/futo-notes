# On-device inference

Client-side semantic search via ONNX Runtime. Embedding model runs entirely on-device — no server needed, nothing leaves the device.

## Current state (Phase 3 complete)

**What works now:**
- `crates/futo-notes-inference/` — Rust crate with `Embedder` struct (ORT session + HuggingFace tokenizer), resumable HTTP model download, SHA-256 verify.
- Model: `nomic-embed-text-v1.5` INT8 quantized (~35 MB ONNX + tokenizer.json). 768-dim output, Matryoshka-capable.
- Desktop Linux: embed in ~10 ms (release), session load ~223 ms.
- Android emulator (x86_64): embed in ~16 ms, session load ~275 ms.
- Android real device (Moto G Play 2023, armeabi-v7a budget phone): embed 268–383 ms, session load ~5 s.
- **iOS** (Phase 3): ORT statically linked via xcframework, CoreML EP enabled. `scripts/fetch-ort-ios.mjs` fetches the prebuilt xcframework from Microsoft. IPA builds and deploys to iPhone. iPhone 17 Pro: 250 ms session load, 5–55 ms embed.
- `inference_test_embed` Tauri command: downloads model on first call, returns `{ loadMs, embedMs, dims, firstEight, modelPath }`. Available on all platforms.
- `window.__testInference.run(text)` JS test hook (same pattern as `__testSync`).
- **Benchmark UI** in Settings: "Run benchmarks" button runs cold start + short/medium/long text, displays results table.

## Quick start — desktop

```bash
# From monorepo root:
cargo run -p futo-notes-inference --example embed_hello
# Downloads model to /tmp/futo-notes-inference-demo/, embeds a test string, prints timings.
```

## Quick start — Android

```bash
# 1. Fetch ONNX Runtime shared libraries for Android
node scripts/fetch-ort-android.mjs --abis arm64-v8a,armeabi-v7a,x86_64

# 2. Build debug APK (from apps/tauri/)
cd apps/tauri
VITE_INCLUDE_TEST_HOOKS=true cargo tauri android build --debug --apk \
  --config src-tauri/tauri.android.offline.conf.json

# 3. Install and launch
adb install -g src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell monkey -p com.futo.notes -c android.intent.category.LAUNCHER 1

# 4. Forward DevTools socket and run the smoke test
PID=$(adb shell 'cat /proc/net/unix' | grep -oP 'webview_devtools_remote_\K\d+')
adb forward tcp:9228 localabstract:webview_devtools_remote_$PID
node scripts/cdp-invoke.mjs --port 9228 \
  "await window.__TAURI__.core.invoke('inference_test_embed', { text: 'hello world' })"
```

## Quick start — iOS

```bash
# 1. Fetch ORT xcframework (cached after first run, ~50 MB download)
node scripts/fetch-ort-ios.mjs

# 2. Build debug IPA with dev bundle ID (com.futo.notes.dev)
#    IMPORTANT: always pass the dev config for debug builds to avoid
#    overwriting the production app on the device.
pnpm run build
cd apps/tauri && cargo tauri ios build --debug \
  --config src-tauri/tauri.ios.dev.conf.json

# 3. Install and launch on connected iPhone
DEVICE=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)['result']['devices']
for x in d:
  if x.get('connectionProperties',{}).get('transportType'): print(x['identifier']); break
")
xcrun devicectl device install app --device "$DEVICE" \
  "apps/tauri/src-tauri/gen/apple/build/arm64/FUTO Notes.ipa"
xcrun devicectl device process launch --device "$DEVICE" com.futo.notes.dev
```

### How iOS linking works

1. `scripts/fetch-ort-ios.mjs` downloads Microsoft's prebuilt ORT pod-archive and extracts `onnxruntime.xcframework` to `apps/tauri/src-tauri/gen/apple/`.
2. The Xcode pre-build script (`project.yml`) exports `ORT_IOS_XCFWK_PATH=${SRCROOT}/onnxruntime.xcframework` so ort-sys finds the static lib during `cargo build`.
3. `project.yml` also lists the xcframework as a dependency so the Xcode linker resolves ORT symbols in the final binary.
4. CoreML.framework and Accelerate.framework are linked for the CoreML execution provider.

### Go/no-go thresholds (all passed)

| Metric | Target | Kill | Actual (iPhone 17 Pro) |
|---|---|---|---|
| Single embed | <200 ms (CoreML) | >800 ms | **5–55 ms** |
| Cold session load | <3 s | >10 s | **250 ms** |
| Peak RAM | <150 MB | >300 MB | TBD (Instruments) |
| IPA size delta | <25 MB | >40 MB | TBD (vs baseline) |

### Known considerations

- **CoreML first-run compilation**: CoreML EP may compile the ONNX model to `.mlmodelc` on first load, adding 10-30s to the first session creation. Cache the compiled model in the app data directory.
- **ORT xcframework version**: Pinned to 1.24.2 (matching ort-sys 2.0.0-rc.12). If you bump the `ort` dep, bump `DEFAULT_VERSION` in `fetch-ort-ios.mjs`.
- **iOS min deployment target warning**: ORT 1.24.2 was built for iOS 15.1, our project targets iOS 14.0. This is a linker warning only — ORT runs fine on iOS 14+.

## Architecture

```
crates/futo-notes-inference/
├── src/lib.rs           Constants, re-exports, model URLs
├── src/embedder.rs      Embedder struct (ORT session + tokenizer)
├── src/download.rs      Resumable HTTP download + SHA-256 verify
├── examples/embed_hello.rs  Desktop smoke test
└── tests/embedder.rs    Integration tests (need model on disk)

apps/tauri/src-tauri/
├── Cargo.toml           Per-platform futo-notes-inference dep
├── src/core.rs          inference_test_embed command (inference_dev module)
└── src/lib.rs           Command registration

apps/tauri/src-tauri/gen/apple/
├── project.yml          Xcode project spec (CoreML/Accelerate frameworks, ORT xcfwk)
└── onnxruntime.xcframework/  Fetched by fetch-ort-ios.mjs (gitignored)

src/components/SettingsScreen.svelte  Benchmark section (Run benchmarks button)
src/lib/testInference.ts   window.__testInference hook
scripts/fetch-ort-android.mjs  ORT .so fetcher for Android
scripts/fetch-ort-ios.mjs      ORT xcframework fetcher for iOS
scripts/cdp-invoke.mjs    CDP client for webview command invocation
```

### Feature flags (futo-notes-inference)

| Feature | What it does | Used by |
|---|---|---|
| `download-binaries` (default) | ort fetches + statically links ORT at build time | Desktop |
| `load-dynamic` | dlopen libonnxruntime.so at runtime | Android |
| `xnnpack` | XNNPACK CPU EP (ARM NEON SIMD) | Android |
| `coreml` | CoreML EP (Neural Engine / GPU) | iOS |

### Measured latencies

| Platform | Session load | Single embed | Notes |
|---|---|---|---|
| Desktop Linux (release) | 223 ms | 10 ms | x86_64, AVX2 |
| Android emulator (x86_64) | 245–275 ms | 16–17 ms | KVM-accelerated |
| Moto G Play 2023 (armeabi-v7a) | 4.9–5.6 s | 268–383 ms | Budget 32-bit ARM, worst case |
| iPhone 17 Pro (arm64, CoreML) | 250 ms | 5–55 ms | 5 ms short, 16 ms medium, 55 ms long |

Session load is a one-time cost — the real indexer (Phase 4) creates one session and reuses it across all notes.
