// Part of the Milkdown wikilinks suite: what it covers and why is described in
// editor-embed-milkdown-wikilinks.spec.ts.

import { expect, type Page } from '@playwright/test';
import { flushFrames, getContent } from './lib/editorEmbedHost';
import { test, open } from './lib/editorEmbedMilkdownWikilinks';

// ============================================================
// IME next to a chip (FB-19, L6f-2)
// ============================================================

/**
 * Milkdown's `inlineNodesCursorPlugin` gives a caret that sits between two
 * non-text inline nodes (two chips, image + chip) somewhere to live, and owns
 * the whole composition there. Upstream's `compositionend` handler returned
 * `true`, which is "handled" — so ProseMirror's own `compositionend` never ran,
 * `view.composing` stayed `true` after the commit and, off Android (where the
 * 5 s composition timeout does not exist), stayed that way until the next
 * composition. Markdown input rules stop while it is set (`- ` typed at the start
 * of a line stays literal), and the host's `isComposing()` — sync deferral, the
 * selection toolbar — reads the same flag.
 *
 * The IME is driven through CDP (`Input.imeSetComposition` + `Input.insertText`):
 * the only way to make Chromium fire the real composition events. Chromium-only,
 * which is the only project this config has.
 */
interface ComposingViewWindow {
  __futoProseMirrorView: () => {
    composing: boolean;
    focus(): void;
    state: {
      doc: {
        content: { size: number };
        firstChild: { nodeSize: number };
        resolve(pos: number): unknown;
        descendants(
          visit: (
            node: { isInline: boolean; isText: boolean },
            pos: number,
            parent: { child(index: number): { isInline: boolean; isText: boolean } },
            index: number,
          ) => boolean | void,
        ): void;
      };
      selection: { constructor: { near(pos: unknown): unknown } };
      tr: { setSelection(selection: unknown): unknown };
    };
    dispatch(tr: unknown): void;
  };
}

type CaretSpot = 'between-chips' | 'line-start' | 'line-end';

/** Positions the caret (a selection, not input) and focuses the editor. */
async function placeCaret(page: Page, spot: CaretSpot): Promise<void> {
  await page.evaluate((where) => {
    const view = (window as unknown as ComposingViewWindow).__futoProseMirrorView();
    const doc = view.state.doc;
    let pos = -1;
    if (where === 'line-start') pos = 1;
    else if (where === 'line-end') pos = doc.firstChild.nodeSize - 1;
    else
      doc.descendants((node, at, parent, index) => {
        if (pos >= 0) return false;
        if (node.isInline && !node.isText && index > 0) {
          const before = parent.child(index - 1);
          if (before.isInline && !before.isText) pos = at;
        }
        return true;
      });
    if (pos < 0) throw new Error('no such caret position in the document');
    view.dispatch(
      view.state.tr.setSelection(view.state.selection.constructor.near(doc.resolve(pos))),
    );
    view.focus();
  }, spot);
}

/**
 * Selects `count` consecutive inline atoms (chips / images), skipping the first
 * `skip`, and focuses the editor. One atom is a NodeSelection, as a tap or an
 * arrow key makes it; more are the text range a drag makes.
 */
async function selectAtoms(page: Page, skip: number, count: number): Promise<void> {
  await page.evaluate(
    ({ skip: skipped, count: n }) => {
      const view = (window as unknown as ComposingViewWindow).__futoProseMirrorView();
      const doc = view.state.doc;
      const at: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isInline && !node.isText) at.push(pos);
        return true;
      });
      const from = at[skipped];
      const last = at[skipped + n - 1];
      if (from === undefined || last === undefined) throw new Error('no such chip in the document');
      const Selection = Object.getPrototypeOf(view.state.selection.constructor) as {
        fromJSON(doc: unknown, json: unknown): unknown;
      };
      const json =
        n === 1 ? { type: 'node', anchor: from } : { type: 'text', anchor: from, head: last + 1 };
      view.dispatch(view.state.tr.setSelection(Selection.fromJSON(doc, json)));
      view.focus();
    },
    { skip, count },
  );
}

const composing = (page: Page) =>
  page.evaluate(() => (window as unknown as ComposingViewWindow).__futoProseMirrorView().composing);

/** A pinyin-style composition that commits `commit`, through the real IME path. */
async function imeCommit(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  for (const text of steps)
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  await cdp.send('Input.insertText', { text: commit });
  await flushFrames(page);
  // The plugin re-inserts the committed text from a rAF; let that land.
  await page.waitForTimeout(100);
  await flushFrames(page);
}

const OCCURRENCES = (text: string, needle: string) => text.split(needle).length - 1;

test.describe('IME commit next to a chip', () => {
  const BETWEEN: Record<string, string> = {
    'two chips': 'para\n\na [[one]][[two]] z\n\nlast\n',
    'an image and a chip': 'para\n\na ![pic](pic.png)[[two]] z\n\nlast\n',
  };

  for (const [shape, markdown] of Object.entries(BETWEEN)) {
    test(`between ${shape}: lands once, composing clears, input rules still run`, async ({
      page,
    }) => {
      await open(page, markdown);
      await placeCaret(page, 'between-chips');
      await imeCommit(page, ['ni', 'nihao'], 'NIHAO');

      const after = await getContent(page);
      expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
      expect(after).not.toMatch(/nihao|ni(?!hao)/);
      // The committed text sits between the two nodes, not before or after them.
      expect(after).toMatch(/[\])]NIHAO\[\[two\]\]/);
      expect.soft(await composing(page)).toBe(false);

      // `- ` at the start of a fresh line is a bullet again: the input rule does
      // not run while `view.composing` is stuck.
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('- item');
      await flushFrames(page);
      await expect(page.locator('.ProseMirror ul li')).toHaveCount(1);
      expect(await getContent(page)).toContain('- item');
    });
  }

  test('plain typing between two chips still lands once', async ({ page }) => {
    await open(page, 'a [[one]][[two]] z\n');
    await placeCaret(page, 'between-chips');
    await page.keyboard.type('QQ');
    await flushFrames(page);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'QQ')).toBe(1);
    expect(after).toContain('[[one]]QQ[[two]]');
  });

  test('a second composition in the next gap commits as cleanly as the first', async ({ page }) => {
    await open(page, 'a [[one]][[two]][[three]] z\n');
    await placeCaret(page, 'between-chips');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    expect(await composing(page)).toBe(false);
    // The first gap now holds text; the next adjacent pair is [[two]][[three]].
    await placeCaret(page, 'between-chips');
    await imeCommit(page, ['sh', 'shijie'], 'SHIJIE');
    expect(await getContent(page)).toContain('[[one]]NIHAO[[two]]SHIJIE[[three]]');
    expect(await composing(page)).toBe(false);
  });

  test('at the start of a line, in front of a chip', async ({ page }) => {
    await open(page, '[[one]] z\n');
    await placeCaret(page, 'line-start');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(after).toContain('NIHAO[[one]]');
    expect(await composing(page)).toBe(false);
  });

  test('at the end of a line, behind a chip', async ({ page }) => {
    await open(page, 'a [[one]]\n');
    await placeCaret(page, 'line-end');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(after).toContain('[[one]]NIHAO');
    expect(await composing(page)).toBe(false);
  });

  // R10-FB19-1. The fork's re-insert runs a frame after the commit. A candidate
  // pick that commits a prefix and keeps composing starts the next composition
  // inside that frame, with the caret still "between" the nodes, so the plugin's
  // `lock` was set for a composition ProseMirror reads natively from then on:
  // its compositionend inserted the text a second time. Two frames' worth of
  // delay is made deterministic by slowing requestAnimationFrame to 30 ms.
  async function slowFrames(page: Page, ms: number): Promise<void> {
    await page.evaluate((delay) => {
      window.requestAnimationFrame = (cb) =>
        window.setTimeout(() => cb(performance.now()), delay) as unknown as number;
    }, ms);
  }

  async function composeInGap(page: Page): Promise<import('@playwright/test').CDPSession> {
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['ni', 'nihao'])
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    return cdp;
  }

  // Chromium drops a live composition silently when the selection or the nodes
  // around it change under it (no compositionend), and the IME then carries on
  // with a fresh composition: that is the sequence below.
  async function continueComposition(cdp: import('@playwright/test').CDPSession): Promise<void> {
    await cdp.send('Input.imeSetComposition', {
      text: 'nihao',
      selectionStart: 5,
      selectionEnd: 5,
    });
    await cdp.send('Input.insertText', { text: 'NIHAO' });
  }

  test('a prefix commit that keeps composing does not duplicate the next commit', async ({
    page,
  }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await slowFrames(page, 30);
    await placeCaret(page, 'between-chips');
    const cdp = await page.context().newCDPSession(page);
    const compose = async (text: string) => {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await page.waitForTimeout(120);
    };
    await compose('ni');
    await compose('nihao');
    await cdp.send('Input.insertText', { text: '你' });
    await compose('hao');
    await compose('haos');
    await compose('haoshi');
    await cdp.send('Input.insertText', { text: '好世' });
    await compose('jie');
    await cdp.send('Input.insertText', { text: '界' });
    await page.waitForTimeout(200);
    await flushFrames(page);
    expect(await getContent(page)).toContain('[[one]]你好世界[[two]]');
    expect(await composing(page)).toBe(false);
  });

  test('a chip deleted mid-composition does not duplicate the commit', async ({ page }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await placeCaret(page, 'between-chips');
    const cdp = await composeInGap(page);
    await page.evaluate(() => {
      const view = (
        window as unknown as {
          __futoProseMirrorView: () => {
            state: { selection: { from: number }; tr: { delete(a: number, b: number): unknown } };
            dispatch(tr: unknown): void;
          };
        }
      ).__futoProseMirrorView();
      const at = view.state.selection.from;
      // The chip to the left of the gap, removed by something other than the IME.
      view.dispatch(view.state.tr.delete(at - 1, at));
    });
    await continueComposition(cdp);
    await flushFrames(page);
    await page.waitForTimeout(100);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(await composing(page)).toBe(false);
  });

  test('a selection moved mid-composition does not duplicate the commit', async ({ page }) => {
    await open(page, 'pre [[one]][[two]] post\n');
    await placeCaret(page, 'between-chips');
    const cdp = await composeInGap(page);
    await placeCaret(page, 'line-end');
    await continueComposition(cdp);
    await flushFrames(page);
    await page.waitForTimeout(100);
    const after = await getContent(page);
    expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
    expect(await composing(page)).toBe(false);
  });

  // RC-97 (FB-19's refuter). A chip that is SELECTED (a NodeSelection: tapped, or
  // reached by an arrow key) and composed over: the IME replaces the selection
  // with the composed text. ProseMirror re-dispatched the selection as a text
  // range under the live composition, Chromium dropped the composition without a
  // `compositionend`, and the commit was lost, the chip stayed and
  // `view.composing` stayed set.
  const SELECTED: Array<[string, string, number, number, string]> = [
    ['a chip', 'pre [[one]] post\n', 0, 1, 'pre NIHAO post'],
    [
      'the middle one of three chips',
      'a [[one]][[two]][[three]] z\n',
      1,
      1,
      '[[one]]NIHAO[[three]]',
    ],
    ['an image', 'pre ![pic](pic.png) post\n', 0, 1, 'pre NIHAO post'],
    ['two chips as a text range', 'pre [[one]][[two]] post\n', 0, 2, 'pre NIHAO post'],
  ];
  for (const [what, markdown, skip, count, expected] of SELECTED) {
    test(`composing over ${what} replaces it and ends the composition`, async ({ page }) => {
      await open(page, markdown);
      await selectAtoms(page, skip, count);
      await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
      const after = await getContent(page);
      expect(OCCURRENCES(after, 'NIHAO')).toBe(1);
      expect(after).toContain(expected);
      expect(after).not.toContain('[[one]][[two]]');
      expect.soft(await composing(page)).toBe(false);
      // Input rules run again: `- ` at the start of a fresh line is a bullet.
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('- item');
      await flushFrames(page);
      await expect(page.locator('.ProseMirror ul li')).toHaveCount(1);
    });
  }

  test('ordinary text is unchanged: commit lands once and composing clears', async ({ page }) => {
    await open(page, 'hello world\n');
    await placeCaret(page, 'line-end');
    await imeCommit(page, ['ni', 'nihao'], 'NIHAO');
    const after = await getContent(page);
    expect(after).toBe('hello worldNIHAO\n');
    expect(await composing(page)).toBe(false);
  });

  test('a character typed right after the commit keeps its order', async ({ page }) => {
    await open(page, 'a [[one]][[two]] z\n');
    await placeCaret(page, 'between-chips');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: 'hello',
      selectionStart: 5,
      selectionEnd: 5,
    });
    await cdp.send('Input.insertText', { text: 'hello' });
    // The next character arrives before the plugin's re-insert has run.
    await page.keyboard.type('X');
    await flushFrames(page);
    await page.waitForTimeout(100);
    expect(await getContent(page)).toContain('[[one]]helloX[[two]]');
  });
});
