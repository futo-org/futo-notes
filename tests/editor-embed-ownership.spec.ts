import { expect, test } from '@playwright/test';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  openEmbed,
  messages,
  clearMessages,
  focusEditor,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

test('a switch inside the debounce reports the outgoing document with its identity', async ({
  browser,
}) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'alpha'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('alpha');
  await focusEditor(page);
  await page.keyboard.press('End');
  await clearMessages(page);
  await page.keyboard.type('word');
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('b', 'beta'),
  );
  const reports = await messages(page);
  expect(reports).toContainEqual(expect.objectContaining({ type: 'edited', noteId: 'a' }));
  const outgoing = reports.findIndex((m) => m.type === 'change' && m.noteId === 'a');
  const loaded = reports.findIndex((m) => m.type === 'documentLoaded' && m.noteId === 'b');
  expect(outgoing).toBeGreaterThanOrEqual(0);
  expect(loaded).toBeGreaterThan(outgoing);
  expect(String(reports[outgoing].content)).toContain('word');
  await context.close();
});

test('edited is a synchronous transition and flush echoes its token once', async ({ browser }) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  await focusEditor(page);
  await clearMessages(page);
  await page.keyboard.type('abcdefgh');
  const edits = (await messages(page)).filter((m) => m.type === 'edited');
  expect(edits).toHaveLength(1);
  expect(edits[0]).toEqual(
    expect.objectContaining({ noteId: 'a', generation: expect.any(Number) }),
  );
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.flush('requested'));
  const reports = (await messages(page)).filter((m) => m.type === 'change');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toEqual(
    expect.objectContaining({
      noteId: 'a',
      flushToken: 'requested',
      content: expect.stringContaining('abcdefgh'),
    }),
  );
  await page.keyboard.type('z');
  expect((await messages(page)).filter((m) => m.type === 'edited')).toHaveLength(2);
  await context.close();
});

test('external content is refused when stale or unreported, then acknowledged after flush', async ({
  browser,
}) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  const loaded = (await messages(page)).find(
    (m) => m.type === 'documentLoaded' && m.noteId === 'a',
  )!;
  await focusEditor(page);
  await page.keyboard.type('typed');
  await page.evaluate(
    (generation) =>
      (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
        'a',
        'peer',
        generation,
      ),
    Number(loaded.generation),
  );
  expect((await messages(page)).filter((m) => m.type === 'externalRefused')).toHaveLength(1);
  await expect(page.locator('.ProseMirror')).toContainText('typed');
  await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.flush('before-adopt');
    w.FutoEditor.applyExternalContent('a', 'peer', w.__futoTest.documentRef().generation);
  });
  await expect(page.locator('.ProseMirror')).toHaveText('peer');
  expect(await messages(page)).toContainEqual(
    expect.objectContaining({ type: 'documentLoaded', noteId: 'a', source: 'external' }),
  );
  await context.close();
});

test('never-loaded flush fails without inventing content', async ({ browser }) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.flush('empty-page'));
  expect(await messages(page)).toContainEqual(
    expect.objectContaining({
      type: 'flushFailed',
      flushToken: 'empty-page',
      reason: 'noDocument',
    }),
  );
  expect((await messages(page)).filter((m) => m.type === 'change')).toHaveLength(0);
  await context.close();
});

test('pagehide reports the pending edit before the debounce', async ({ browser }) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  await focusEditor(page);
  await clearMessages(page);
  await page.keyboard.type('word');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect((await messages(page)).filter((m) => m.type === 'change')).toEqual([
    expect.objectContaining({ noteId: 'a', content: expect.stringContaining('word') }),
  ]);
  await context.close();
});

test('a typing burst costs one edited message and one debounced change', async ({ browser }) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  await focusEditor(page);
  await clearMessages(page);
  await page.keyboard.type('abcdefgh');
  await expect
    .poll(async () => (await messages(page)).filter((m) => m.type === 'change').length)
    .toBe(1);
  expect((await messages(page)).filter((m) => m.type === 'edited')).toHaveLength(1);
  await context.close();
});

for (const edge of ['blur', 'visibility'] as const) {
  test(`${edge} flushes the pending edit before native lifecycle work`, async ({ browser }) => {
    const { context, page } = await openEmbed(browser, EDITOR_URL);
    await page.evaluate(() =>
      (window as unknown as FakeHostWindow).FutoEditor.setContent('a', 'base'),
    );
    await expect(page.locator('.ProseMirror')).toContainText('base');
    await focusEditor(page);
    await clearMessages(page);
    await page.keyboard.type('word');
    await page.evaluate((edge) => {
      if (edge === 'blur') (window as unknown as FakeHostWindow).FutoEditor.blur();
      else {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    }, edge);
    expect((await messages(page)).filter((m) => m.type === 'change')).toEqual([
      expect.objectContaining({ noteId: 'a', content: expect.stringContaining('word') }),
    ]);
    await context.close();
  });
}

test('streaming announces an edit synchronously and a flush reports the complete tail once', async ({
  browser,
}) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  const note = Array.from({ length: 800 }, (_, i) => `Paragraph ${i}.`).join('\n\n') + '\n';
  await page.evaluate((note) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.setContent('stream', note);
    w.__msgs.length = 0;
    const view = (
      window as unknown as {
        __futoProseMirrorView(): import('@milkdown/kit/prose/view').EditorView;
      }
    ).__futoProseMirrorView();
    view.dispatch(view.state.tr.insertText('marker', 1));
    if (w.__msgs.filter((m) => m.type === 'edited').length !== 1)
      throw new Error('streaming edit was silent');
    if (w.__msgs.some((m) => m.type === 'change'))
      throw new Error('streaming published before flush');
    w.FutoEditor.flush('stream-flush');
  }, note);
  const changes = (await messages(page)).filter((m) => m.type === 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0]).toEqual(
    expect.objectContaining({ noteId: 'stream', flushToken: 'stream-flush' }),
  );
  expect(String(changes[0].content)).toContain('marker');
  expect(String(changes[0].content)).toContain('Paragraph 799.');
  await context.close();
});

test('retargeting an acknowledged live document preserves the typed tail, caret and undo', async ({
  browser,
}) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('old', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' tail');
  await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.flush('before-retarget');
    const live = w.__futoTest.readDocument();
    w.FutoEditor.setContent('new', live);
  });
  await expect(page.locator('.ProseMirror')).toHaveText('base tail');
  await page.keyboard.type('!');
  await expect(page.locator('.ProseMirror')).toHaveText('base tail!');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ProseMirror')).toHaveText('base');
  expect(await messages(page)).toContainEqual(
    expect.objectContaining({ type: 'documentLoaded', noteId: 'new' }),
  );
  await context.close();
});

test('a keystroke between the flush and a rename retarget survives under the new identity', async ({
  browser,
}) => {
  const { context, page } = await openEmbed(browser, EDITOR_URL);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('old', 'base'),
  );
  await expect(page.locator('.ProseMirror')).toContainText('base');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' tail');
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.flush('before-retarget'),
  );
  // The rename's commit window: the shell holds the flushed bytes, the user keeps typing.
  await page.keyboard.type(' late');
  await clearMessages(page);
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.retarget('old', 'new'),
  );
  await expect(page.locator('.ProseMirror')).toHaveText('base tail late');
  expect((await messages(page)).filter((m) => m.type === 'change')).toEqual([
    expect.objectContaining({ noteId: 'new', content: 'base tail late\n' }),
  ]);
  // A retarget naming a document the editor no longer holds changes nothing.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.retarget('old', 'other'),
  );
  expect(
    await page.evaluate(
      () => (window as unknown as FakeHostWindow).__futoTest.documentRef().noteId,
    ),
  ).toBe('new');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ProseMirror')).toHaveText('base');
  await context.close();
});
