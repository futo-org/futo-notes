// Live source families share the existing worker and registered vault owner.
import { dividerPendingConsumer } from './wasm-divider-pending-consumer.mjs';
import { anglePendingConsumer } from './wasm-angle-consumer.mjs';
import { typedOriginConsumer } from './wasm-typed-origin-consumer.mjs';
import { sourceGenerationsConsumer } from './wasm-source-generations-consumer.mjs';

export async function liveSourceConsumers({ start, stop, getSession, createRoot }) {
  {
    const angleVault = createRoot('futo-editor-wasm-angle-');
    const codeVault = createRoot('futo-editor-wasm-angle-code-');
    const partialCodeVault = createRoot('futo-editor-wasm-partial-code-');
    const codeReleaseVault = createRoot('futo-editor-wasm-code-release-');
    await anglePendingConsumer({
      start,
      stop,
      getSession,
      root: angleVault,
      codeRoot: codeVault,
      partialRoot: partialCodeVault,
      releaseRoot: codeReleaseVault,
    });
  }
  {
    const sourceVault = createRoot('futo-editor-wasm-source-generations-');
    const prefixVault = createRoot('futo-editor-wasm-prefix-');
    await sourceGenerationsConsumer({
      start,
      stop,
      getSession,
      root: sourceVault,
      prefixRoot: prefixVault,
    });
  }
  await typedOriginConsumer({ start, stop, getSession, createRoot });
  await dividerPendingConsumer({
    start,
    stop,
    getSession,
    root: createRoot('futo-editor-wasm-divider-pending-'),
    referenceRoot: createRoot('futo-editor-wasm-divider-reference-'),
  });
}
