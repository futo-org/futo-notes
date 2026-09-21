import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { EDITOR_BUNDLE_PATH, EDITOR_URL } from './editorEmbedBundle';
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
  // floor is below every version here).
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

test('the Android engine probe reports a mounted editor as booted', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await expect(page.locator('.ProseMirror')).toBeAttached();
  await expect.poll(() => probeEngine(page)).toBe('booted');
  await context.close();
});

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

// ============================================================
// Legacy WebView CSS floor — github#8 (@layer) and github#33 (inset)
//
// Moved here verbatim when `editor-embed-bridge.spec.ts` was deleted at the
// engine swap. They were written against `.cm-content`/`.cm-scroller` because
// that was the editor at the time; the bug they lock is the BUNDLE's CSS
// floor, not any editor's, so they are retargeted at `.ProseMirror` — which
// under Milkdown is both the text surface and the scroll container.
// ============================================================

/**
 * Remove `@layer a, b;` statements and balanced `@layer ... { ... }` blocks.
 * Comments go first (a browser ignores them; the scanner must too — the
 * editor.html inline style talks ABOUT @layer in prose).
 */
function stripCssLayerRules(rawCss: string): string {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@layer', i);
    if (at === -1) {
      out += css.slice(i);
      return out;
    }
    out += css.slice(i, at);
    let j = at + '@layer'.length;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
    if (css[j] === ';') {
      i = j + 1;
      continue;
    }
    let depth = 0;
    do {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    } while (j < css.length && depth > 0);
    i = j;
  }
}

/** The bundle as a pre-@layer engine sees it: all layered CSS discarded. */
function writeLegacyWebViewBundle(): string {
  const html = readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
  const stripped = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/g,
    (_m, attrs: string, css: string) => `<style${attrs}>${stripCssLayerRules(css)}</style>`,
  );
  const legacyPath = path.join(path.dirname(EDITOR_BUNDLE_PATH), 'editor-legacy-webview-test.html');
  writeFileSync(legacyPath, stripped);
  return `file://${legacyPath}`;
}

// Expected text colors come from the theme tokens so this spec can never
// drift from src/styles/theme.css.
function themeTextColor(theme: 'light' | 'dark'): string {
  const css = readFileSync(path.resolve('src/styles/theme.css'), 'utf8');
  const scope =
    theme === 'dark'
      ? css.slice(css.indexOf("[data-theme='dark']"))
      : css.slice(0, css.indexOf("[data-theme='dark']"));
  const hex = /--color-text:\s*#([0-9a-fA-F]{6})/.exec(scope)?.[1];
  if (!hex) throw new Error(`--color-text (${theme}) not found in src/styles/theme.css`);
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function editorContentColor(
  browser: Browser,
  url: string,
  theme: 'light' | 'dark',
): Promise<string> {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate((t) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.setTheme(t);
    w.FutoEditor.setContent('legible text probe');
  }, theme);
  await flushFrames(page);
  const color = await page.locator('.ProseMirror').evaluate((el) => getComputedStyle(el).color);
  await context.close();
  return color;
}

// Non-updated Android 8-10 system WebViews predate @layer support and drop
// EVERY rule inside Tailwind's @layer blocks — including the theme variables
// and the editor's text color. Both native hosts render the editor web view
// transparent over a native surface, so in dark mode the lost text color
// degrades to UA black-on-dark: invisible notes. Reproduced for real on
// Chromium 98 (r950370) headless, 2026-07-23.
test('legacy WebView (no @layer): dark theme text keeps the dark token color', async ({
  browser,
}) => {
  const url = writeLegacyWebViewBundle();
  expect(await editorContentColor(browser, url, 'dark')).toBe(themeTextColor('dark'));
});

test('legacy WebView (no @layer): light theme text keeps the light token color', async ({
  browser,
}) => {
  const url = writeLegacyWebViewBundle();
  expect(await editorContentColor(browser, url, 'light')).toBe(themeTextColor('light'));
});

test('modern engine: the unlayered fallback does not fight the layered theme', async ({
  browser,
}) => {
  expect(await editorContentColor(browser, EDITOR_URL, 'dark')).toBe(themeTextColor('dark'));
  expect(await editorContentColor(browser, EDITOR_URL, 'light')).toBe(themeTextColor('light'));
});

function engineVerdict(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as unknown as { __futoEngineUnsupported: string | null }).__futoEngineUnsupported,
  );
}

test('engine preflight: a modern engine reports no missing capability', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  expect(await engineVerdict(page)).toBeNull();
  await context.close();
});

test('engine preflight: an engine below the ES2020 floor is reported unsupported', async ({
  browser,
}) => {
  const context = await browser.newContext();
  // Simulate a pre-ES2020 parser: the preflight decides by compiling the syntax
  // it needs through `new Function`, so make exactly that compilation throw the
  // SyntaxError an old engine would. `prototype` is carried over so `instanceof
  // Function` keeps working for everything else on the page. No host is
  // installed — the verdict is set by a classic <head> script, before any bundle.
  await context.addInitScript(() => {
    const real = window.Function;
    const stub = function (this: unknown, ...args: string[]) {
      if (/\?\.|\?\?/.test(args[args.length - 1] ?? '')) {
        throw new SyntaxError('simulated pre-ES2020 engine');
      }
      return (real as (...a: string[]) => unknown)(...args);
    };
    stub.prototype = real.prototype;
    Object.defineProperty(window, 'Function', { value: stub, configurable: true });
  });
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  expect(await engineVerdict(page)).toContain('ES2020 syntax');
  await context.close();
});

/**
 * The bundle as a Chromium 80-86 WebView sees it — the band that runs the whole
 * bundle but predates two things the layout leans on, so BOTH have to go for
 * this to be the real engine rather than a convenient half of it:
 *
 *  - `@layer` (Chromium 99): every layered rule is discarded, which takes
 *    src/styles/base.css's `body { position: fixed; inset: 0 }` with it.
 *  - the `inset` shorthand (Chromium 87): that one declaration is dropped and
 *    the rest of its rule kept, exactly as an unsupported declaration is.
 *
 * Only the shorthand: `inset-inline`/`inset-block` are separate properties and
 * are not what this emulates.
 */
function writePreInsetWebViewBundle(): string {
  const html = readFileSync(EDITOR_BUNDLE_PATH, 'utf8');
  const stripped = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/g,
    (_m, attrs: string, css: string) =>
      `<style${attrs}>${stripCssLayerRules(css).replace(/(^|[;{\s])inset\s*:[^;}]*;?/g, '$1')}</style>`,
  );
  const legacyPath = path.join(path.dirname(EDITOR_BUNDLE_PATH), 'editor-pre-inset-test.html');
  writeFileSync(legacyPath, stripped);
  return `file://${legacyPath}`;
}

interface EmbedGeometry {
  editorWidth: number;
  editorHeight: number;
  editorTop: number;
  innerWidth: number;
  innerHeight: number;
  scrollerOverflow: number;
  documentScrollTop: number;
}

async function embedGeometry(page: Page): Promise<EmbedGeometry> {
  return page.evaluate(() => {
    const editor = document.getElementById('editor') as HTMLElement;
    // `.ProseMirror` is the scroll container under Milkdown (it carries
    // `overflow-y: auto`), where CodeMirror had a separate `.cm-scroller`.
    const scroller = document.querySelector('.ProseMirror') as HTMLElement;
    const box = editor.getBoundingClientRect();
    return {
      editorWidth: Math.round(box.width),
      editorHeight: Math.round(box.height),
      editorTop: Math.round(box.top),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollerOverflow: scroller.scrollHeight - scroller.clientHeight,
      documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
    };
  });
}

async function openPreInsetEmbed(browser: Browser, markdown: string) {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 393, height: 700 },
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(writePreInsetWebViewBundle());
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent(md),
    markdown,
  );
  await flushFrames(page);
  return { context, page };
}

// github#33: on an Android System WebView older than Chromium 87 the editor
// pane filled itself with `inset: 0`, which that engine drops — so `#editor`
// shrink-wrapped its text instead of filling the web view, the editor's
// `height: 100%` resolved against an auto-height parent, and nothing became a
// scroll container. The note then grew past the bottom of the pane with
// nothing to scroll, and scroll-cursor-into-view moved the ROOT document
// instead, sliding the note up under the shell's native title bar. Reported on
// FUTO Notes 1.7.0 / Android 10.
test('pre-inset WebView: the editor pane still fills the web view', async ({ browser }) => {
  const { context, page } = await openPreInsetEmbed(browser, 'a short note');

  const geometry = await embedGeometry(page);
  expect(geometry.editorWidth).toBe(geometry.innerWidth);
  expect(geometry.editorHeight).toBe(geometry.innerHeight);
  await context.close();
});

// The consequence the user actually sees: with a definite height chain, the
// editor itself takes the overflow, so revealing the cursor never scrolls the
// root document out from under the native title.
test('pre-inset WebView: a long note scrolls inside the editor, not the document', async ({
  browser,
}) => {
  const { context, page } = await openPreInsetEmbed(
    browser,
    Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n\n'),
  );
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);

  const geometry = await embedGeometry(page);
  expect(geometry.scrollerOverflow).toBeGreaterThan(0);
  expect(geometry.documentScrollTop).toBe(0);
  expect(geometry.editorTop).toBe(0);
  await context.close();
});
