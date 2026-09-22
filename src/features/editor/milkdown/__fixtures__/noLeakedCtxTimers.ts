/*
 * Guards against a real `@milkdown/ctx` resource leak that only surfaces
 * under CI-timing luck: pipeline 36487's `test` job failed with 11
 * `ReferenceError: removeEventListener is not defined` uncaught exceptions,
 * each attributed to whatever test file happened to be running when the
 * error fired — never the file that actually caused it.
 *
 * The mechanism (confirmed by reading and directly exercising
 * `node_modules/@milkdown/ctx/lib/index.js`'s `Timer`/`Clock`/`Ctx` classes):
 * every real `Editor.make()…create()` calls `ctx.wait()` on ~9 lifecycle
 * gates (ConfigReady, InitReady, SchemaReady, …). `Timer#start()` schedules a
 * raw `setTimeout(…, 3000)` for each one and NEVER stores or clears the
 * returned handle — not even once the gate resolves via its normal `done()`
 * event. `editor.destroy()` calls `ctx.clearTimer()` for each gate, but that
 * only deletes the Timer from `Clock`'s bookkeeping `Map`; it does not touch
 * the underlying native timer. So every real editor a test builds leaves
 * ~9 native timers pending for 3 seconds, `destroy()` or not.
 *
 * When one of those stray timers finally fires, its callback unconditionally
 * calls the bare `removeEventListener` identifier. That is harmless while a
 * jsdom environment is live — but vitest's jsdom-environment teardown
 * (`keys.forEach((key) => delete global[key])`, `removeEventListener` among
 * them) really deletes that global once a test FILE's jsdom environment ends.
 * If the stray timer fires later than that — inside a subsequent, unrelated
 * file sharing the same worker process, which is exactly what a slow/
 * contended CI runner makes far more likely than a fast local run — the bare
 * reference throws a `ReferenceError`, reported against whatever file is
 * executing at that moment.
 *
 * Wrap any span that builds a real Milkdown `Editor` (directly via
 * `Editor.make()`, or indirectly by mounting `MilkdownEditor.svelte`) with
 * this so the leaked native timers are captured and force-cancelled the
 * instant the span completes. By then every one of ctx's `wait()` promises
 * has already settled via the real `done()` event (that is what the awaited
 * span proves) — cancelling the redundant, already-served timeout throws
 * nothing away.
 */
export async function withoutLeakedCtxTimers<T>(buildRealEditor: () => Promise<T>): Promise<T> {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = realSetTimeout(handler as never, timeout, ...args);
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  try {
    return await buildRealEditor();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const id of pending) clearTimeout(id);
  }
}
