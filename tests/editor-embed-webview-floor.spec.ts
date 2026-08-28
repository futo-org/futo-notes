import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { CM6_EDITOR_URL, EDITOR_BUNDLE_PATH, EDITOR_URL } from './editorEmbedBundle';
import { flushFrames, installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

/**
 * The Android System WebView floor, executable.
 *
 * github#8 was a blank editor pane on old WebViews, and the lesson it left
 * (project history + apps/android/AGENTS.md) is that a floor is only as good as
 * an audit of the BUILT bundle: the syntax target is easy to reason about, but
 * a dependency reaching for a newer built-in method loads fine and then throws
 * at runtime. That is exactly how `Element.replaceChildren` (Chromium 86)
 * shipped inside a bundle whose declared floor was 80.
 *
 * Milkdown made this live again — `@milkdown/transformer` calls
 * `Array.prototype.at` (Chromium 92) on every parse and every serialize — so
 * this spec keeps the two halves of the floor honest:
 *
 *   1. BEHAVIOUR: with each post-floor built-in deleted (what a WebView below
 *      its version actually looks like), the shipping editor still mounts,
 *      renders a document, and serializes it back to markdown — which is the
 *      round trip `.at` sits in the middle of.
 *   2. AUDIT: the built bundle uses no post-floor built-in that is NOT covered
 *      by a shim in `editor.html`. A new dependency that reaches past the floor
 *      fails here instead of on a user's phone.
 *
 * The floor number itself is read from the Android gate so a bump can never be
 * recorded in only one place.
 */

const ENGINE_SUPPORT_KT = path.resolve(
  'apps/android/app/src/main/java/com/futo/notes/ui/EditorEngineSupport.kt',
);

/** The floor the Android notice quotes — the single source for this spec. */
function declaredChromiumFloor(): number {
  const source = readFileSync(ENGINE_SUPPORT_KT, 'utf8');
  const major = /EDITOR_CHROMIUM_FLOOR_MAJOR\s*=\s*(\d+)/.exec(source)?.[1];
  if (!major) throw new Error(`EDITOR_CHROMIUM_FLOOR_MAJOR not found in ${ENGINE_SUPPORT_KT}`);
  return Number(major);
}

/**
 * Built-ins the bundle uses that arrived AFTER the floor, each one shimmed by
 * `editor.html`'s classic pre-bundle script. `remove` is what the pre-shim
 * engine looks like; `pattern` is what the audit greps the built bundle for.
 *
 * Adding an entry here is a deliberate act: it says "the shim carries this",
 * and the behaviour test then proves the shim actually does.
 */
const SHIMMED_BUILTINS = [
  {
    name: 'String.prototype.replaceAll',
    chromium: 85,
    // Svelte 5's client runtime calls it during mount (github#8).
    pattern: /\.replaceAll\(/,
    remove: () => {
      delete (String.prototype as { replaceAll?: unknown }).replaceAll;
    },
    present: () => typeof (String.prototype as { replaceAll?: unknown }).replaceAll,
  },
  {
    name: 'Array.prototype.at',
    chromium: 92,
    // @milkdown/transformer's serializer stack (`elements.at(-1)`) and its
    // mark-merge / trailing-space passes: hit on every parse and every save.
    pattern: /[\w)\]]\.at\(/,
    remove: () => {
      delete (Array.prototype as { at?: unknown }).at;
      delete (String.prototype as { at?: unknown }).at;
    },
    present: () => typeof (Array.prototype as { at?: unknown }).at,
  },
] as const;

/**
 * Post-floor built-ins the bundle must NOT reach for without a shim. Each is a
 * real runtime break on an engine below its version — the class of bug that
 * loads clean and then throws. Keep the version numbers next to the names: they
 * are what a reviewer checks.
 *
 * A NAMED LIST, not a proof: this greps a minified bundle, so an aliased or
 * computed access (`const f = arr.at; f.call(x, -1)`) walks past it. It catches
 * the way dependencies actually write these calls, which is how
 * `Element.replaceChildren` should have been caught the first time.
 */
const UNSHIMMED_POST_FLOOR_BUILTINS: ReadonlyArray<{
  pattern: RegExp;
  chromium: number;
  name: string;
}> = [
  { pattern: /\.replaceChildren\(/, chromium: 86, name: 'Element.replaceChildren' },
  { pattern: /\bWeakRef\b|\bFinalizationRegistry\b/, chromium: 84, name: 'WeakRef' },
  { pattern: /\bPromise\.any\(|\bAggregateError\b/, chromium: 85, name: 'Promise.any' },
  { pattern: /\bIntl\.Segmenter\b/, chromium: 87, name: 'Intl.Segmenter' },
  { pattern: /\bcrypto\.randomUUID\(/, chromium: 92, name: 'crypto.randomUUID' },
  { pattern: /\bObject\.hasOwn\(/, chromium: 93, name: 'Object.hasOwn' },
  { pattern: /new Error\([^)]*\{\s*cause:/, chromium: 93, name: 'Error cause' },
  { pattern: /\.findLast(Index)?\(/, chromium: 97, name: 'Array.prototype.findLast' },
  { pattern: /\bstructuredClone\(/, chromium: 98, name: 'structuredClone' },
  { pattern: /\bAbortSignal\.timeout\(/, chromium: 103, name: 'AbortSignal.timeout' },
  {
    pattern: /\.toSorted\(|\.toReversed\(|\.toSpliced\(/,
    chromium: 110,
    name: 'Array change-by-copy',
  },
  {
    pattern: /\bObject\.groupBy\(|\bMap\.groupBy\(/,
    chromium: 117,
    name: 'Object.groupBy / Map.groupBy',
  },
  { pattern: /\bPromise\.withResolvers\b/, chromium: 119, name: 'Promise.withResolvers' },
  { pattern: /\bArray\.fromAsync\b/, chromium: 121, name: 'Array.fromAsync' },
];

function bundleSource(): string {
  return readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
}

/** A window of bundle text around the first match, for a legible failure. */
function excerpt(source: string, at: number): string {
  return source.slice(Math.max(0, at - 90), at + 90).replace(/\s+/g, ' ');
}

/**
 * Opens the shipping editor with `remove` applied before any page script runs,
 * then proves it is a working editor: it mounted, it rendered the document it
 * was handed, and it serialized that document back out. `url` is passed so the
 * same proof covers both engines the bundle ships.
 */
async function editorSurvivesWithout(
  browser: Browser,
  url: string,
  remove: () => void,
): Promise<{ serialized: string; page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(remove);
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('floor probe'),
  );
  await flushFrames(page);
  return {
    serialized: await page.evaluate(() =>
      (window as unknown as FakeHostWindow).FutoEditor.getContent(),
    ),
    page,
    close: () => context.close(),
  };
}

for (const builtin of SHIMMED_BUILTINS) {
  // The engine that lacks this built-in is a real, still-supported WebView (the
  // floor is below every version here). Both engines have to survive it while
  // the bundle ships two.
  test(`below Chromium ${builtin.chromium} (no ${builtin.name}): the Milkdown editor still round-trips`, async ({
    browser,
  }) => {
    const { serialized, page, close } = await editorSurvivesWithout(
      browser,
      EDITOR_URL,
      builtin.remove,
    );
    expect(serialized.trim()).toBe('floor probe');
    await expect(page.locator('.ProseMirror')).toContainText('floor probe');
    // The shim fills in only when the method is missing, so finding it now
    // proves the shim ran rather than a native method that was never removed.
    expect(await page.evaluate(builtin.present)).toBe('function');
    await close();
  });

  test(`below Chromium ${builtin.chromium} (no ${builtin.name}): the CodeMirror editor still round-trips`, async ({
    browser,
  }) => {
    const { serialized, page, close } = await editorSurvivesWithout(
      browser,
      CM6_EDITOR_URL,
      builtin.remove,
    );
    expect(serialized.trim()).toBe('floor probe');
    await expect(page.locator('.cm-content')).toContainText('floor probe');
    await close();
  });
}

// Every shim at once — the honest picture of an engine at the floor, where none
// of them exist. Shims that work one at a time can still fight each other.
// Composed from SHIMMED_BUILTINS rather than re-listed, so a new shim is covered
// here the moment it is added.
test('an engine at the floor, with every shimmed built-in missing, runs the editor', async ({
  browser,
}) => {
  const { serialized, page, close } = await editorSurvivesWithout(browser, EDITOR_URL, () => {
    for (const remove of removeEveryShimmedBuiltin) remove();
  });
  expect(serialized.trim()).toBe('floor probe');
  await expect(page.locator('.ProseMirror')).toContainText('floor probe');
  await close();
});

// A shim on Array.prototype that is enumerable rewrites `for (const k in arr)`
// for the whole page — including every dependency in the bundle. The polyfill
// has to be invisible to iteration or it trades a blank pane for corruption.
test('the Array.prototype.at shim never becomes an enumerable own key', async ({ browser }) => {
  const { page, close } = await editorSurvivesWithout(browser, EDITOR_URL, () => {
    delete (Array.prototype as { at?: unknown }).at;
  });
  expect(await page.evaluate(() => Object.keys(['a', 'b']))).toEqual(['0', '1']);
  expect(
    await page.evaluate(() => {
      const seen: string[] = [];
      for (const key in ['a', 'b']) seen.push(key);
      return seen;
    }),
  ).toEqual(['0', '1']);
  await close();
});

// The audit. github#8's `replaceChildren` shipped inside a bundle whose floor
// said 80 and nothing caught it until a slow review did; this is that review as
// a test.
test('the built bundle reaches for no post-floor built-in the shims do not cover', async () => {
  const source = bundleSource();
  const floor = declaredChromiumFloor();
  const offenders: string[] = [];
  for (const { pattern, chromium, name } of UNSHIMMED_POST_FLOOR_BUILTINS) {
    if (chromium <= floor) continue;
    const match = pattern.exec(source);
    if (!match) continue;
    offenders.push(
      `${name} (Chromium ${chromium}) at offset ${match.index}: …${excerpt(source, match.index)}…`,
    );
  }
  expect(
    offenders,
    `The bundle would throw on a Chromium ${floor} WebView. Either shim these in editor.html ` +
      "(and move them to SHIMMED_BUILTINS), remove the dependency's use of them, or raise the " +
      'floor — which is a support-surface change, not a test fix.',
  ).toEqual([]);
});

// The other direction: a shim whose built-in the bundle stopped using is dead
// weight in a file every WebView parses before the editor, and its behaviour
// test above then proves nothing.
test('every shim in editor.html is still earning its place in the bundle', () => {
  const source = bundleSource();
  const unused = SHIMMED_BUILTINS.filter((b) => !b.pattern.test(source)).map((b) => b.name);
  expect(
    unused,
    'The bundle no longer uses these — delete the shim from editor.html and the entry here.',
  ).toEqual([]);
});

/* ------------------------------------------------------------------------ *
 * The gate itself: "the editor mounted" has to mean the EDITOR, not the host
 * API next to it.
 *
 * Measured on futo-api30 (Chromium 83, Android 11): with the Array.prototype.at
 * shim removed, opening a note gave a blank editor pane and the "update Android
 * System WebView" notice NEVER appeared — not even after the boot grace period.
 * Milkdown's `Editor.make().create()` is async, so Svelte's synchronous
 * `mount()` returns (and `window.FutoEditor` is published, and `ready` is
 * posted) whether or not the engine came up behind it. The gate read
 * `window.FutoEditor` and called that a healthy engine.
 *
 * So the editor now publishes its own mount, and these tests hold the two ends
 * of that: the real probe program is read out of the Android source rather than
 * re-spelled here, so a change on either side fails.
 * ------------------------------------------------------------------------ */

/** The Kotlin host's probe program, with its Kotlin interpolations resolved. */
function engineProbeProgram(): string {
  const source = readFileSync(ENGINE_SUPPORT_KT, 'utf8');
  const body = /ENGINE_PROBE_JS\s*=\s*"""([\s\S]*?)"""/.exec(source)?.[1];
  if (!body) throw new Error(`ENGINE_PROBE_JS not found in ${ENGINE_SUPPORT_KT}`);
  return body.replace(/\$(\w+)/g, (whole, name: string) => {
    const value = new RegExp(`val ${name}\\s*=\\s*"([^"]*)"`).exec(source)?.[1];
    if (value === undefined) throw new Error(`ENGINE_PROBE_JS interpolates unknown ${whole}`);
    return value;
  });
}

function probeEngine(page: Page): Promise<string> {
  return page.evaluate(engineProbeProgram()) as Promise<string>;
}

/**
 * Every `remove` in SHIMMED_BUILTINS, in one array the all-at-once init script
 * closes over. Module scope because `addInitScript` serialises the function it
 * is handed, and a serialised closure can only reach module-level bindings.
 */
const removeEveryShimmedBuiltin = SHIMMED_BUILTINS.map((b) => b.remove);

/**
 * The shipping bundle with the `Array.prototype.at` shim disabled — a Chromium
 * 80–91 WebView as it was before this work. One-line, brace-balanced, and
 * asserted to have changed something so it can never silently no-op.
 */
function writeUnshimmedBundle(): string {
  const html = readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
  const guard = 'if (!Array.prototype.at) define(Array.prototype);';
  if (!html.includes(guard)) throw new Error('editor.html no longer guards the at shim this way');
  const unshimmed = html.replace(guard, '');
  const target = path.join(path.dirname(EDITOR_BUNDLE_PATH), 'editor-unshimmed-at-test.html');
  writeFileSync(target, unshimmed);
  return `file://${target}`;
}

for (const [engine, url, contentSelector] of [
  ['Milkdown', EDITOR_URL, '.ProseMirror'],
  ['CodeMirror', CM6_EDITOR_URL, '.cm-content'],
] as const) {
  test(`the Android engine probe reports a mounted ${engine} editor as booted`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await expect(page.locator(contentSelector)).toBeAttached();
    await expect.poll(() => probeEngine(page)).toBe('booted');
    await context.close();
  });
}

test('an editor that never mounts is not reported as booted, so the notice can show', async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(() => {
    delete (Array.prototype as { at?: unknown }).at;
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(writeUnshimmedBundle());
  // `ready` still posts: the host API is published by the module's top level,
  // which is exactly why it cannot stand in for a mounted editor.
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await flushFrames(page);
  expect(await page.locator('.ProseMirror').count()).toBe(0);
  // 'pending' is the honest answer, and it is what the host's grace-period
  // probe turns into "bundle never mounted" -> LegacyWebViewNotice.
  expect(await probeEngine(page)).toBe('pending');
  await context.close();
});
