// Dev/test hook for on-device embedding — mirrors `testSync.ts`.
//
// Exposed as `window.__testInference` in debug builds and when
// `VITE_INCLUDE_TEST_HOOKS=true`. Lets us drive the Rust `inference_test_embed`
// command from the MCP/webview console without building UI for it first.
//
// Usage from webview-execute-js:
//
//   const r = await window.__testInference.run('hello world');
//   // { loadMs, embedMs, dims, firstEight: number[], modelPath }
//
// On first call the Rust side downloads nomic-embed-text-v1.5 (~35 MB), so
// allow ~30s for the initial invocation on a slow connection.

import { invoke } from '@tauri-apps/api/core';

export interface InferenceTestResult {
  loadMs: number;
  embedMs: number;
  dims: number;
  firstEight: number[];
  modelPath: string;
}

export interface TestInferenceApi {
  run(text?: string): Promise<InferenceTestResult>;
}

declare global {
  interface Window {
    __testInference?: TestInferenceApi;
  }
}

async function runInferenceTest(
  text: string = 'The quick brown fox jumps over the lazy dog.',
): Promise<InferenceTestResult> {
  return invoke<InferenceTestResult>('inference_test_embed', { text });
}

export function installTestInference(target: Window = window): void {
  target.__testInference = {
    run: runInferenceTest,
  };
}
