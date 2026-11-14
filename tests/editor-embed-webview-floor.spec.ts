import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { EDITOR_BUNDLE_PATH, EDITOR_URL } from './editorEmbedBundle';
import { flushFrames, installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

/**
 * Standalone browser compatibility fixture. Keep the built bundle's existing
 * Chromium 80 shim coverage independent of the retired mobile web hosts.
 * Syntax targeting alone cannot protect a dependency that calls a newer
 * built-in, so both runtime round trips and the built bundle are checked.
 * Mobile uses native Rust sessions and has no Chromium requirement.
 */
const CHROMIUM_FIXTURE_MAJOR = 80;

/**
 * Built-ins the bundle uses that arrived AFTER the floor, each one shimmed by
 * `editor.html`'s classic pre-bundle script. `remove` is what the pre-shim
 * engine looks like; `pattern` is what the audit greps the built bundle for.
 *
 * Adding an entry here is a deliberate act: it says "the shim carries this",
 * and the behavior test then proves the shim actually does.
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
 * same proof covers any isolated bundle fixture.
 */
async function editorSurvivesWithout(
  browser: Browser,
  url: string,
  remove: (() => void) | string,
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
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', 'floor probe'),
  );
  await flushFrames(page);
  return {
    serialized: await page.evaluate(() =>
      (window as unknown as FakeHostWindow).__futoTest.readDocument(),
    ),
    page,
    close: () => context.close(),
  };
}

for (const builtin of SHIMMED_BUILTINS) {
  // Delete the method before startup to exercise the bundle’s fallback.
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
}

// Every shim at once — the honest picture of an engine at the floor, where none
// of them exist. Shims that work one at a time can still fight each other.
// Composed from SHIMMED_BUILTINS rather than re-listed, so a new shim is covered
// here the moment it is added.
test('an engine at the floor, with every shimmed built-in missing, runs the editor', async ({
  browser,
}) => {
  const { serialized, page, close } = await editorSurvivesWithout(
    browser,
    EDITOR_URL,
    removeEveryShimmedBuiltin,
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __futoCompatMissingBeforeBundle: string[] })
          .__futoCompatMissingBeforeBundle,
    ),
  ).toEqual(['undefined', 'undefined', 'undefined']);
  for (const builtin of SHIMMED_BUILTINS) {
    expect(await page.evaluate(builtin.present)).toBe('function');
  }
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
  const floor = CHROMIUM_FIXTURE_MAJOR;
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
    `The standalone fixture would throw on Chromium ${floor}. Either shim these in editor.html ` +
      "(and move them to SHIMMED_BUILTINS), remove the dependency's use of them, or raise the " +
      'fixture baseline deliberately.',
  ).toEqual([]);
});

// The other direction: a shim whose built-in the bundle stopped using is dead
// weight in a file every WebView parses before the editor, and its behavior
// test above then proves nothing.
test('every shim in editor.html is still earning its place in the bundle', () => {
  const source = bundleSource();
  const unused = SHIMMED_BUILTINS.filter((b) => !b.pattern.test(source)).map((b) => b.name);
  expect(
    unused,
    'The bundle no longer uses these — delete the shim from editor.html and the entry here.',
  ).toEqual([]);
});

// Execute each removal in the browser context; serialized init scripts cannot
// close over this test module's bindings. Record the pre-bundle state so this
// combined test cannot silently pass without deleting the methods.
const removeEveryShimmedBuiltin =
  SHIMMED_BUILTINS.map((builtin) => `(${builtin.remove.toString()})();`).join('\n') +
  '\nglobalThis.__futoCompatMissingBeforeBundle = [' +
  'typeof String.prototype.replaceAll, typeof Array.prototype.at, typeof String.prototype.at];';
