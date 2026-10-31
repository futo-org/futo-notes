// Live source families share the existing worker and registered vault owner.
import { dividerPendingConsumer } from './wasm-divider-pending-consumer.mjs';
import { anglePendingConsumer } from './wasm-angle-consumer.mjs';
import { typedOriginConsumer } from './wasm-typed-origin-consumer.mjs';
import { sourceGenerationsConsumer } from './wasm-source-generations-consumer.mjs';

export async function liveSourceConsumers({ start, stop, getSession, createRoot }) {
  const checked = (story) => () =>
    new Proxy(getSession(), {
      get(session, key) {
        const value = session[key];
        if (typeof value !== 'function') return value;
        return (...args) => {
          try {
            return value.apply(session, args);
          } catch (cause) {
            throw new Error(
              `${story}: ${String(key)}(${args.map(String).join(', ')}) failed; status=${session.status()}; source=${JSON.stringify(session.draft_text())}`,
              { cause },
            );
          }
        };
      },
    });
  {
    const angleVault = createRoot('futo-editor-wasm-angle-');
    const codeVault = createRoot('futo-editor-wasm-angle-code-');
    const partialCodeVault = createRoot('futo-editor-wasm-partial-code-');
    const codeReleaseVault = createRoot('futo-editor-wasm-code-release-');
    await anglePendingConsumer({
      start,
      stop,
      getSession: checked('HTTP angle / Code'),
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
      getSession: checked('source generations'),
      root: sourceVault,
      prefixRoot: prefixVault,
    });
  }
  await typedOriginConsumer({ start, stop, getSession: checked('WWW typed origin'), createRoot });
  await dividerPendingConsumer({
    start,
    stop,
    getSession: checked('Divider pending'),
    root: createRoot('futo-editor-wasm-divider-pending-'),
    referenceRoot: createRoot('futo-editor-wasm-divider-reference-'),
  });
}
