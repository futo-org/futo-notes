import { test, expect, Page } from '@playwright/test';

async function setupEditor(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');

  await page.evaluate((text) => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
  }, content);

  await page.waitForTimeout(200);
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(200);
}

async function getVisibleEditorText(page: Page): Promise<string> {
  return page.locator('.cm-content').evaluate((el) => (el as HTMLElement).innerText);
}

async function getSelectionState(page: Page): Promise<{ empty: boolean; text: string }> {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const selection = view.state.selection.main;
    return {
      empty: selection.empty,
      text: view.state.doc.sliceString(selection.from, selection.to),
    };
  });
}

async function startLineMutationObserver(page: Page, text: string): Promise<void> {
  await page.evaluate((lineText) => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find((el) =>
      (el as HTMLElement).innerText.includes(lineText)
    );
    if (!line) throw new Error(`Line not found: ${lineText}`);

    const w = window as any;
    w.__lineMutationSummary = { childList: 0, attributes: 0, characterData: 0, total: 0 };
    w.__lineMutationObserver?.disconnect?.();
    w.__lineMutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        w.__lineMutationSummary.total += 1;
        if (record.type === 'childList') w.__lineMutationSummary.childList += 1;
        else if (record.type === 'attributes') w.__lineMutationSummary.attributes += 1;
        else if (record.type === 'characterData') w.__lineMutationSummary.characterData += 1;
      }
    });
    w.__lineMutationObserver.observe(line, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }, text);
}

async function stopLineMutationObserver(
  page: Page,
): Promise<{ childList: number; attributes: number; characterData: number; total: number }> {
  return page.evaluate(() => {
    const w = window as any;
    w.__lineMutationObserver?.disconnect?.();
    return w.__lineMutationSummary;
  });
}

async function getVisibleTextPoint(
  page: Page,
  substring: string,
  side: 'start' | 'end',
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ substring, side }) => {
    const root = document.querySelector('.cm-content');
    if (!root) throw new Error('CM content not found');

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const start = text.indexOf(substring);
      if (start === -1) continue;

      const target = side === 'start'
        ? start
        : start + substring.length;
      const from = side === 'start'
        ? Math.min(target, Math.max(0, text.length - 1))
        : Math.max(0, target - 1);
      const to = side === 'start'
        ? Math.min(text.length, from + 1)
        : Math.min(text.length, target);

      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const rect = Array.from(range.getClientRects()).at(side === 'start' ? 0 : -1)
        ?? range.getBoundingClientRect();

      return {
        x: side === 'start' ? rect.left + 1 : rect.right - 1,
        y: (rect.top + rect.bottom) / 2,
      };
    }

    throw new Error(`Visible substring not found: ${substring}`);
  }, { substring, side });
}

async function getElementDragPoints(
  page: Page,
  selector: string,
): Promise<{ start: { x: number; y: number }; end: { x: number; y: number } }> {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Expected bounding box for ${selector}`);
  return {
    start: { x: box.x + 4, y: box.y + box.height / 2 },
    end: { x: box.x + box.width - 4, y: box.y + box.height / 2 },
  };
}

interface TextDragTarget {
  kind: 'text';
  startText: string;
  endText: string;
}

interface ElementDragTarget {
  kind: 'element';
  selector: string;
}

interface SelectionRevealCase {
  name: string;
  markdown: string;
  rawSyntax: string;
  drag: TextDragTarget | ElementDragTarget;
  assertVisibleTextSyntax?: boolean;
}

type DragDirection = 'forward' | 'backward';

const IMAGE_SRC = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2232%22%20height=%2218%22%3E%3Crect%20width=%2232%22%20height=%2218%22%20fill=%22%23000%22/%3E%3C/svg%3E';

const revealCases: SelectionRevealCase[] = [
  {
    name: 'heading',
    markdown: '# Heading One',
    rawSyntax: '# Heading One',
    drag: { kind: 'text', startText: 'Heading', endText: 'One' },
  },
  {
    name: 'italic',
    markdown: 'This is *italic text* here.',
    rawSyntax: '*italic text*',
    drag: { kind: 'text', startText: 'italic', endText: 'text' },
  },
  {
    name: 'bold',
    markdown: 'This is **bold text** here.',
    rawSyntax: '**bold text**',
    drag: { kind: 'text', startText: 'bold', endText: 'text' },
  },
  {
    name: 'strikethrough',
    markdown: 'This is ~~struck text~~ here.',
    rawSyntax: '~~struck text~~',
    drag: { kind: 'text', startText: 'struck', endText: 'text' },
  },
  {
    name: 'inline code',
    markdown: 'Use `inline code` here.',
    rawSyntax: '`inline code`',
    drag: { kind: 'text', startText: 'inline', endText: 'code' },
  },
  {
    name: 'markdown link',
    markdown: 'Check [link text](https://example.com) here.',
    rawSyntax: '[link text](https://example.com)',
    drag: { kind: 'text', startText: 'Check', endText: 'here' },
  },
  {
    name: 'wikilink',
    markdown: 'Open [[Daily Note]] soon.',
    rawSyntax: '[[Daily Note]]',
    drag: { kind: 'text', startText: 'Open', endText: 'soon' },
  },
  {
    name: 'blockquote',
    markdown: '> Quote text',
    rawSyntax: '> Quote text',
    drag: { kind: 'text', startText: 'Quote', endText: 'text' },
    assertVisibleTextSyntax: false,
  },
  {
    name: 'unordered list',
    markdown: '- List item',
    rawSyntax: '- List item',
    drag: { kind: 'text', startText: 'List', endText: 'item' },
  },
  {
    name: 'ordered list',
    markdown: '1. Ordered item',
    rawSyntax: '1. Ordered item',
    drag: { kind: 'text', startText: 'Ordered', endText: 'item' },
  },
  {
    name: 'task list',
    markdown: '- [x] Task done',
    rawSyntax: '- [x] Task done',
    drag: { kind: 'text', startText: 'Task', endText: 'done' },
  },
  {
    name: 'fenced code block',
    markdown: '```ts\nconst value = 1;\n```',
    rawSyntax: '```ts',
    drag: { kind: 'text', startText: 'const', endText: '1;' },
  },
  {
    name: 'image',
    markdown: `Before\n\n![Alt text](${IMAGE_SRC})\n\nAfter`,
    rawSyntax: `![Alt text](${IMAGE_SRC})`,
    drag: { kind: 'text', startText: 'Before', endText: 'After' },
  },
  {
    name: 'table',
    markdown: 'Before\n\n| A | B |\n|---|---|\n| C | D |\n\nAfter',
    rawSyntax: '| A | B |',
    drag: { kind: 'text', startText: 'Before', endText: 'After' },
  },
  {
    name: 'horizontal rule',
    markdown: 'Before\n\n---\n\nAfter',
    rawSyntax: '---',
    drag: { kind: 'element', selector: '.cm-md-hr-widget' },
  },
];

async function getDragPoints(
  page: Page,
  drag: TextDragTarget | ElementDragTarget,
  direction: DragDirection,
): Promise<{ start: { x: number; y: number }; end: { x: number; y: number } }> {
  if (drag.kind === 'element') {
    const points = await getElementDragPoints(page, drag.selector);
    return direction === 'forward'
      ? points
      : { start: points.end, end: points.start };
  }

  if (direction === 'forward') {
    return {
      start: await getVisibleTextPoint(page, drag.startText, 'start'),
      end: await getVisibleTextPoint(page, drag.endText, 'end'),
    };
  }

  return {
    start: await getVisibleTextPoint(page, drag.endText, 'end'),
    end: await getVisibleTextPoint(page, drag.startText, 'start'),
  };
}

async function dragSelectionAndReadStates(
  page: Page,
  points: { start: { x: number; y: number }; end: { x: number; y: number } },
): Promise<{
  duringText: string;
  duringSelection: { empty: boolean; text: string };
  duringQuoteMarkerVisible: boolean | null;
  afterText: string;
  afterSelection: { empty: boolean; text: string };
  afterQuoteMarkerVisible: boolean | null;
}> {
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 20 });
  await page.waitForTimeout(100);

  const duringText = await getVisibleEditorText(page);
  const duringSelection = await getSelectionState(page);
  const duringQuoteMarkerVisible = await quoteMarkerVisibility(page);

  await page.mouse.up();
  await page.waitForTimeout(250);

  const afterText = await getVisibleEditorText(page);
  const afterSelection = await getSelectionState(page);
  const afterQuoteMarkerVisible = await quoteMarkerVisibility(page);

  return { duringText, duringSelection, duringQuoteMarkerVisible, afterText, afterSelection, afterQuoteMarkerVisible };
}

async function quoteMarkerVisibility(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const marker = document.querySelector('.cm-md-quote-marker, .cm-md-quote-marker-hidden') as HTMLElement | null;
    if (!marker) return null;
    const style = window.getComputedStyle(marker);
    return style.fontSize !== '0px' && style.color !== 'rgba(0, 0, 0, 0)';
  });
}

test.describe('Markdown selection reveal timing', () => {
  for (const revealCase of revealCases) {
    for (const direction of ['forward', 'backward'] as const) {
      test(`${revealCase.name} syntax stays hidden during ${direction} drag and reveals after mouseup`, async ({ page }) => {
        await setupEditor(page, revealCase.markdown);

        const beforeText = await getVisibleEditorText(page);
        if (revealCase.assertVisibleTextSyntax === false) {
          expect(await quoteMarkerVisibility(page)).toBe(false);
        } else {
          expect(beforeText).not.toContain(revealCase.rawSyntax);
        }

        const points = await getDragPoints(page, revealCase.drag, direction);
        const { duringText, duringSelection, duringQuoteMarkerVisible, afterText, afterSelection, afterQuoteMarkerVisible } =
          await dragSelectionAndReadStates(page, points);

        expect.soft(duringSelection.empty, `${revealCase.name} should create a ${direction} selection while dragging`).toBe(false);
        expect.soft(afterSelection.empty, `${revealCase.name} should keep a ${direction} selection after mouseup`).toBe(false);
        if (revealCase.assertVisibleTextSyntax === false) {
          expect.soft(duringQuoteMarkerVisible, `${revealCase.name} marker should stay hidden during ${direction} drag`).toBe(false);
          expect.soft(afterQuoteMarkerVisible, `${revealCase.name} marker should reveal after mouseup after ${direction} drag`).toBe(true);
        } else {
          expect.soft(duringText, `${revealCase.name} should not reveal before mouseup during ${direction} drag`).not.toContain(revealCase.rawSyntax);
          expect.soft(afterText, `${revealCase.name} should reveal after mouseup after ${direction} drag`).toContain(revealCase.rawSyntax);
        }
      });
    }
  }

  test('heading selection reveals after forward drag from heading line to next line', async ({ page }) => {
    await setupEditor(page, '# Howdy\nyes');

    const beforeText = await getVisibleEditorText(page);
    expect(beforeText).not.toContain('# Howdy');

    const points = {
      start: await getVisibleTextPoint(page, 'Howdy', 'start'),
      end: await getVisibleTextPoint(page, 'yes', 'end'),
    };
    const { duringText, duringSelection, afterText, afterSelection } =
      await dragSelectionAndReadStates(page, points);

    expect.soft(duringSelection.empty, 'heading forward selection should exist during drag').toBe(false);
    expect.soft(afterSelection.empty, 'heading forward selection should remain after mouseup').toBe(false);
    expect.soft(afterSelection.text, 'heading forward selection should include the hidden marker').toContain('# Howdy');
    expect.soft(duringText, 'heading marker should stay hidden during forward drag').not.toContain('# Howdy');
    expect.soft(afterText, 'heading marker should reveal after forward mouseup').toContain('# Howdy');
    await expect(page.locator('.cm-md-h1', { hasText: 'Howdy' })).toBeVisible();
  });

  test('blockquote line does not re-render while drag-selecting its visible text', async ({ page }) => {
    await setupEditor(page, [
      '**hey man** how is it *going*.',
      '',
      '# Howdy',
      'yes',
      '',
      '- meow',
      '- haha',
      '',
      '> four score and seven years ago',
      '',
      '```',
      'code goes here',
      'and why',
      '```',
      '',
      '`yes` maam',
    ].join('\n'));

    await startLineMutationObserver(page, 'four score and seven years ago');

    const points = {
      start: await getVisibleTextPoint(page, 'four', 'start'),
      end: await getVisibleTextPoint(page, 'ago', 'end'),
    };
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 40 });
    await page.waitForTimeout(100);

    const duringSelection = await getSelectionState(page);
    const mutations = await stopLineMutationObserver(page);

    await page.mouse.up();

    expect(duringSelection.empty).toBe(false);
    expect(duringSelection.text).toBe('four score and seven years ago');
    expect(mutations).toEqual({ childList: 0, attributes: 0, characterData: 0, total: 0 });
  });

  test('non-drag mousedown after revealing bold markers keeps them visible', async ({ page }) => {
    await setupEditor(page, 'This is **bold** text.');

    const point = await getVisibleTextPoint(page, 'bold', 'start');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(150);

    expect(await getVisibleEditorText(page)).toContain('**bold**');

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await getVisibleEditorText(page)).toContain('**bold**');

    await page.mouse.up();
  });

  test('drag from already-revealed bold text keeps markers visible during selection', async ({ page }) => {
    await setupEditor(page, 'This is **bold text** here.');

    const start = await getVisibleTextPoint(page, 'bold', 'start');
    const end = await getVisibleTextPoint(page, 'text', 'end');
    await page.mouse.click(start.x, start.y);
    await page.waitForTimeout(150);

    expect(await getVisibleEditorText(page)).toContain('**bold text**');

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 20 });
    await page.waitForTimeout(100);

    expect(await getVisibleEditorText(page)).toContain('**bold text**');

    await page.mouse.up();
  });

  test('non-drag mousedown on hidden bold markers waits until mouseup to reveal', async ({ page }) => {
    await setupEditor(page, 'This is **bold** text.');

    const point = await getVisibleTextPoint(page, 'bold', 'start');
    expect(await getVisibleEditorText(page)).not.toContain('**bold**');

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await getVisibleEditorText(page)).not.toContain('**bold**');

    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await getVisibleEditorText(page)).toContain('**bold**');
  });

  test('non-drag mousedown after revealing a blockquote marker keeps it visible', async ({ page }) => {
    await setupEditor(page, '> Quote text');

    const point = await getVisibleTextPoint(page, 'Quote', 'start');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(150);

    expect(await quoteMarkerVisibility(page)).toBe(true);

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await quoteMarkerVisibility(page)).toBe(true);

    await page.mouse.up();
  });

  test('drag from already-revealed blockquote keeps marker visible during selection', async ({ page }) => {
    await setupEditor(page, '> four score and seven years ago');

    const start = await getVisibleTextPoint(page, 'years', 'start');
    const end = await getVisibleTextPoint(page, 'ago', 'end');
    await page.mouse.click(start.x, start.y);
    await page.waitForTimeout(150);

    expect(await quoteMarkerVisibility(page)).toBe(true);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 20 });
    await page.waitForTimeout(100);

    expect(await quoteMarkerVisibility(page)).toBe(true);

    await page.mouse.up();
  });

  test('non-drag mousedown at blockquote line end waits until mouseup to reveal marker', async ({ page }) => {
    await setupEditor(page, '> four score and seven years ago');

    const agoEnd = await getVisibleTextPoint(page, 'ago', 'end');
    const point = { x: agoEnd.x + 24, y: agoEnd.y };
    expect(await quoteMarkerVisibility(page)).toBe(false);

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(100);

    expect(await quoteMarkerVisibility(page)).toBe(false);

    await page.mouse.up();
    await page.waitForTimeout(150);

    expect(await quoteMarkerVisibility(page)).toBe(true);
  });

  test('heading selection reveals after backward drag from next line to heading line', async ({ page }) => {
    await setupEditor(page, '# Howdy\nyes');

    const beforeText = await getVisibleEditorText(page);
    expect(beforeText).not.toContain('# Howdy');

    const points = {
      start: await getVisibleTextPoint(page, 'yes', 'end'),
      end: await getVisibleTextPoint(page, 'Howdy', 'start'),
    };
    const { duringText, duringSelection, afterText, afterSelection } =
      await dragSelectionAndReadStates(page, points);

    expect.soft(duringSelection.empty, 'heading backward selection should exist during drag').toBe(false);
    expect.soft(afterSelection.empty, 'heading backward selection should remain after mouseup').toBe(false);
    expect.soft(afterSelection.text, 'heading backward selection should include the hidden marker').toContain('# Howdy');
    expect.soft(duringText, 'heading marker should stay hidden during backward drag').not.toContain('# Howdy');
    expect.soft(afterText, 'heading marker should reveal after backward mouseup').toContain('# Howdy');
    await expect(page.locator('.cm-md-h1', { hasText: 'Howdy' })).toBeVisible();
  });

  test('heading selection reveals after backward drag that extends above the heading', async ({ page }) => {
    await setupEditor(page, 'above\n# Howdy\nyes');

    const beforeText = await getVisibleEditorText(page);
    expect(beforeText).not.toContain('# Howdy');

    const points = {
      start: await getVisibleTextPoint(page, 'yes', 'end'),
      end: await getVisibleTextPoint(page, 'above', 'start'),
    };
    const { duringText, duringSelection, afterText, afterSelection } =
      await dragSelectionAndReadStates(page, points);

    expect.soft(duringSelection.empty, 'extended backward heading selection should exist during drag').toBe(false);
    expect.soft(afterSelection.empty, 'extended backward heading selection should remain after mouseup').toBe(false);
    expect.soft(afterSelection.text, 'extended backward heading selection should include the hidden marker').toContain('# Howdy');
    expect.soft(duringText, 'heading marker should stay hidden while dragging above the heading').not.toContain('# Howdy');
    expect.soft(afterText, 'heading marker should reveal after mouseup when selection spans the heading').toContain('# Howdy');
    await expect(page.locator('.cm-md-h1', { hasText: 'Howdy' })).toBeVisible();
  });

  test('heading selection reveals after forward drag from above the heading', async ({ page }) => {
    await setupEditor(page, 'above\n# Howdy\nyes');

    const beforeText = await getVisibleEditorText(page);
    expect(beforeText).not.toContain('# Howdy');

    const points = {
      start: await getVisibleTextPoint(page, 'above', 'start'),
      end: await getVisibleTextPoint(page, 'yes', 'end'),
    };
    const { duringText, duringSelection, afterText, afterSelection } =
      await dragSelectionAndReadStates(page, points);

    expect.soft(duringSelection.empty, 'forward heading selection from above should exist during drag').toBe(false);
    expect.soft(afterSelection.empty, 'forward heading selection from above should remain after mouseup').toBe(false);
    expect.soft(afterSelection.text, 'forward heading selection from above should include the hidden marker').toContain('# Howdy');
    expect.soft(duringText, 'heading marker should stay hidden while dragging from above the heading').not.toContain('# Howdy');
    expect.soft(afterText, 'heading marker should reveal after mouseup when forward selection spans the heading').toContain('# Howdy');
    await expect(page.locator('.cm-md-h1', { hasText: 'Howdy' })).toBeVisible();
  });

  for (const direction of ['forward', 'backward'] as const) {
    test(`inline tag decoration stays during ${direction} drag and drops after mouseup`, async ({ page }) => {
      await setupEditor(page, 'Remember #project today.');

      await expect(page.locator('.cm-md-tag')).toHaveCount(1);

      const points = await getDragPoints(
        page,
        { kind: 'text', startText: 'Remember', endText: 'today' },
        direction,
      );

      await page.mouse.move(points.start.x, points.start.y);
      await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 20 });
      await page.waitForTimeout(100);

      const duringSelection = await getSelectionState(page);
      const duringTagCount = await page.locator('.cm-md-tag').count();

      await page.mouse.up();
      await page.waitForTimeout(250);

      const afterSelection = await getSelectionState(page);
      const afterTagCount = await page.locator('.cm-md-tag').count();

      expect.soft(duringSelection.empty, `inline tag should create a ${direction} selection while dragging`).toBe(false);
      expect.soft(afterSelection.empty, `inline tag should keep a ${direction} selection after mouseup`).toBe(false);
      expect.soft(duringTagCount, `inline tag should keep the tag decoration before ${direction} mouseup`).toBe(1);
      expect.soft(afterTagCount, `inline tag should drop the tag decoration after ${direction} mouseup`).toBe(0);
    });
  }
});
