# On-device inference

Client-side semantic search via ONNX Runtime. Embedding model runs entirely on-device — no server needed, nothing leaves the device.

## Current state (Phase 2 complete)

**What works now:**
- `crates/stonefruit-inference/` — Rust crate with `Embedder` struct (ORT session + HuggingFace tokenizer), resumable HTTP model download, SHA-256 verify.
- Model: `nomic-embed-text-v1.5` INT8 quantized (~35 MB ONNX + tokenizer.json). 768-dim output, Matryoshka-capable.
- Desktop Linux: embed in ~10 ms (release), session load ~223 ms.
- Android emulator (x86_64): embed in ~16 ms, session load ~275 ms.
- Android real device (Moto G Play 2023, armeabi-v7a budget phone): embed 268–383 ms, session load ~5 s.
- `inference_test_embed` Tauri command: downloads model on first call, returns `{ loadMs, embedMs, dims, firstEight, modelPath }`.
- `window.__testInference.run(text)` JS test hook (same pattern as `__testSync`).

**What's next (Phase 3 — iOS):**
- Add CoreML execution provider for Neural Engine/GPU acceleration on iPhone.
- Static-link ORT (iOS forbids dynamic libraries).
- Measure latency, binary size, peak RAM on a real iPhone.

## Quick start — desktop

```bash
# From monorepo root:
cargo run -p stonefruit-inference --example embed_hello
# Downloads model to /tmp/stonefruit-inference-demo/, embeds a test string, prints timings.
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

## Picking up Phase 3 on macOS

Phase 3 adds iOS support via ORT's CoreML execution provider. Here's what to do on the Mac:

### Prerequisites

- Xcode with iOS 14.0+ SDK
- A real iPhone connected (simulator won't exercise CoreML/ANE properly)
- Rust with `aarch64-apple-ios` target: `rustup target add aarch64-apple-ios`

### What needs to happen

1. **Add `stonefruit-inference` dep for iOS** in `apps/tauri/src-tauri/Cargo.toml`:

   Currently iOS is excluded. Add a new target section:

   ```toml
   [target.'cfg(target_os = "ios")'.dependencies]
   stonefruit-inference = { path = "../../../crates/stonefruit-inference", default-features = false, features = ["coreml"] }
   ```

   The `coreml` feature enables `ort/coreml`. iOS forbids dynamic libraries, so we need ORT statically linked — this may require the `compile-library` ort feature or providing a prebuilt static `.a`. Start by trying without `download-binaries` and see if ort-sys has an iOS entry in its `dist.txt`.

2. **Add Apple frameworks** to `apps/tauri/src-tauri/gen/apple/project.yml`:

   The current framework list (around line 73-81) has CoreGraphics, Metal, MetalKit, etc. Add:
   - `CoreML.framework`
   - `Accelerate.framework`
   - `Foundation.framework` (may already be implicit)

3. **Update the cfg gate** in `apps/tauri/src-tauri/src/core.rs`:

   Currently `inference_dev` and `inference_test_embed` are gated on `not(target_os = "ios")`. Once the dep is linked, change to unconditional (or remove the iOS exclusion).

4. **Build and test:**

   ```bash
   cd apps/tauri && cargo tauri ios build --debug
   # Install via Xcode or devicectl
   # Use the same CDP approach (Safari Web Inspector or cdp-invoke.mjs)
   ```

5. **Measure with Instruments:**

   Open the Core ML instrument template in Xcode to see if the model runs on ANE, GPU, or CPU. Record the answer — it determines whether CoreML EP adds value over plain CPU EP on iOS.

### Go/no-go thresholds for Phase 3

| Metric | Target | Kill |
|---|---|---|
| Single embed | <200 ms (CoreML) / <400 ms (CPU fallback) | >800 ms |
| Cold session load | <3 s | >10 s |
| Peak RAM | <150 MB | >300 MB |
| IPA size delta | <25 MB | >40 MB |

### Key risks

- **Static linking ORT for iOS**: ort-sys' build script may not cross-compile cleanly for `aarch64-apple-ios`. If it fails, try providing a prebuilt static `.a` via `ORT_LIB_LOCATION` env var. Microsoft publishes iOS builds in their GitHub releases.
- **CoreML first-run compilation**: CoreML EP may compile the ONNX model to `.mlmodelc` on first load, adding 10-30s to the first session creation. Cache the compiled model in the app data directory.
- **MoE routing on ANE**: nomic-embed-text-v1.5 is NOT an MoE model (v2 is), so this risk doesn't apply. v1.5 is a standard BERT architecture which CoreML handles well.

## Architecture

```
crates/stonefruit-inference/
├── src/lib.rs           Constants, re-exports, model URLs
├── src/embedder.rs      Embedder struct (ORT session + tokenizer)
├── src/download.rs      Resumable HTTP download + SHA-256 verify
├── examples/embed_hello.rs  Desktop smoke test
└── tests/embedder.rs    Integration tests (need model on disk)

apps/tauri/src-tauri/
├── Cargo.toml           Per-platform stonefruit-inference dep
├── src/core.rs          inference_test_embed command (inference_dev module)
└── src/lib.rs           Command registration

src/lib/testInference.ts   window.__testInference hook
scripts/fetch-ort-android.mjs  ORT .so fetcher for Android
scripts/cdp-invoke.mjs    CDP client for webview command invocation
```

### Feature flags (stonefruit-inference)

| Feature | What it does | Used by |
|---|---|---|
| `download-binaries` (default) | ort fetches + statically links ORT at build time | Desktop |
| `load-dynamic` | dlopen libonnxruntime.so at runtime | Android |
| `xnnpack` | XNNPACK CPU EP (ARM NEON SIMD) | Android |
| `coreml` | CoreML EP (Neural Engine / GPU) | iOS (Phase 3) |

### Measured latencies

| Platform | Session load | Single embed | Notes |
|---|---|---|---|
| Desktop Linux (release) | 223 ms | 10 ms | x86_64, AVX2 |
| Android emulator (x86_64) | 245–275 ms | 16–17 ms | KVM-accelerated |
| Moto G Play 2023 (armeabi-v7a) | 4.9–5.6 s | 268–383 ms | Budget 32-bit ARM, worst case |
| iPhone (Phase 3) | TBD | TBD | — |

Session load is a one-time cost — the real indexer (Phase 4) creates one session and reuses it across all notes.
