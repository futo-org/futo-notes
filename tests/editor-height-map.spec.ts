import { test, expect, Page } from '@playwright/test';

/**
 * CM6 resolves clicks, arrow motion, Cmd-Backspace and drag-select through
 * `posAtCoords`, which picks its block from the HEIGHT MAP and only then refines
 * inside it against the DOM. So any block whose measured height disagrees with
 * the space it occupies on screen breaks every geometry query below it — and
 * cumulatively, once per offending block.
 *
 * `getBoundingClientRect().height` excludes CSS margins, so a margin on a block
 * widget's root is exactly such a disagreement. `.sf-table { margin: 8px 0 }`
 * cost 16px per table: one ArrowUp from below a table jumped the caret to the
 * first line ABOVE it.
 *
 * The invariant below is the cheap general guard — it fails for any future
 * widget with a margin, not just tables.
 */

const HORIZONTAL_RULE_ESTIMATED_HEIGHT = 50;
const TABLE_SOURCE_LINES = 7;

const WIDGET_HEAVY_NOTE = [
  '# Heading',
  '',
  'A paragraph with **bold**, *italic*, `code`, a [link](https://example.com), a',
  '[[wikilink]] and a #tag.',
  '',
  '- bullet one',
  '- bullet two',
  '  - nested',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '- [ ] unchecked task',
  '- [x] checked task',
  '',
  '> a blockquote line',
  '',
  '---',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| x | y |',
  '',
  'ALPHA line',
  '',
  '| C | D |',
  '| --- | --- |',
  '| p | q |',
  '| r | s |',
  '',
  'BRAVO line',
  '',
  'CHARLIE line',
  '',
  'DELTA line',
  '',
].join('\n');

async function openNote(page: Page, title: string, body: string): Promise<void> {
  // Tall enough that CM6 renders the whole document — the drift scan can only
  // check lines that exist in the DOM, and `assertWholeDocumentRendered` below
  // makes that coverage explicit rather than silently partial.
  await page.setViewportSize({ width: 1000, height: 1600 });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as { __testNotes?: unknown }).__testNotes, null, {
    timeout: 15000,
  });
  await page.evaluate(
    async ({ title, body }) => {
      await (
        window as unknown as { __testNotes: { createNote(t: string, b: string): Promise<void> } }
      ).__testNotes.createNote(title, body);
    },
    { title, body },
  );
  await page.evaluate((id) => {
    window.location.hash = `#/note/${encodeURIComponent(id)}`;
  }, title);
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(
    (expected) =>
      (window as { __cmGetView?: () => { state: { doc: { toString(): string } } } | null })
        .__cmGetView?.()
        ?.state.doc.toString() === expected,
    body,
    { timeout: 10000 },
  );
  await page.waitForSelector('.sf-table', { timeout: 10000 });
  await settleHeightMap(page);
}

/**
 * Wait for CM6 to finish measuring, without asserting anything about the result:
 * two equal samples of `contentHeight` a poll apart. A wrong height map settles
 * just as readily as a right one, so this cannot mask the invariant under test.
 */
async function settleHeightMap(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete (window as { __heightMapSample?: number }).__heightMapSample;
  });
  await page.waitForFunction(
    () => {
      const global = window as { __cmGetView?: () => any; __heightMapSample?: number };
      const view = global.__cmGetView?.();
      if (!view) return false;
      const settled = global.__heightMapSample === view.contentHeight;
      global.__heightMapSample = view.contentHeight;
      return settled;
    },
    null,
    { polling: 250, timeout: 10000 },
  );
}

function readHeightMap(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
    const contentRect = view.contentDOM.getBoundingClientRect();
    const docTop = contentRect.top + view.viewState.paddingTop;
    const drifted: Array<{ line: number; text: string; drift: number }> = [];
    let measuredLines = 0;

    for (let n = 1; n <= view.state.doc.lines; n += 1) {
      const line = view.state.doc.line(n);
      let lineTop: number | null = null;
      try {
        const at = view.domAtPos(line.from);
        const node = at.node.nodeType === 1 ? at.node : at.node.parentElement;
        const lineElement = (node as HTMLElement | null)?.closest('.cm-line');
        if (lineElement) lineTop = lineElement.getBoundingClientRect().top;
      } catch {
        lineTop = null;
      }
      if (lineTop === null) continue;
      measuredLines += 1;
      const drift = lineTop - docTop - view.lineBlockAt(line.from).top;
      if (Math.abs(drift) > 1.5) drifted.push({ line: n, text: line.text.slice(0, 30), drift });
    }

    return {
      drifted,
      measuredLines,
      viewportCoversDocument:
        view.viewport.from === 0 && view.viewport.to === view.state.doc.length,
    };
  });
}

test.describe('editor height map', () => {
  test('every rendered block measures the space it occupies', async ({ page }) => {
    await openNote(page, 'Height map', WIDGET_HEAVY_NOTE);

    const { drifted, measuredLines, viewportCoversDocument } = await readHeightMap(page);

    expect(viewportCoversDocument, 'the scan must cover the whole document').toBe(true);
    expect(measuredLines, 'lines the scan actually resolved to a .cm-line').toBeGreaterThanOrEqual(
      WIDGET_HEAVY_NOTE.split('\n').length - TABLE_SOURCE_LINES,
    );
    expect(drifted, 'lines whose height-map position disagrees with the DOM').toEqual([]);
  });

  test('a table widget renders at the height it estimates', async ({ page }) => {
    await openNote(page, 'Table estimate', WIDGET_HEAVY_NOTE);

    const tables = await page.evaluate(() => {
      const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
      return Array.from(document.querySelectorAll('.sf-table')).map((element) => {
        const block = view.lineBlockAt(view.posAtDOM(element));
        return {
          bodyRows: element.querySelectorAll('tbody tr').length,
          rendered: element.getBoundingClientRect().height,
          estimated: block.widget ? block.widget.estimatedHeight : null,
        };
      });
    });

    expect(tables.length).toBe(2);
    for (const table of tables) {
      expect(table.estimated, 'the widget CM6 holds for this block').not.toBeNull();
      expect(
        Math.abs(table.rendered - (table.estimated as number)),
        `a ${table.bodyRows}-row table renders ${table.rendered}px but its widget ` +
          `estimates ${table.estimated}px`,
      ).toBeLessThanOrEqual(3);
    }
  });

  test('a horizontal rule line measures the height the widget estimates', async ({ page }) => {
    await openNote(page, 'Rule estimate', WIDGET_HEAVY_NOTE);

    const rule = await page.evaluate(() => {
      const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
      const widget = document.querySelector('.cm-md-hr-widget') as HTMLElement;
      const line = widget.closest('.cm-line') as HTMLElement;
      return {
        widget: widget.getBoundingClientRect().height,
        line: line.getBoundingClientRect().height,
        block: view.lineBlockAt(view.posAtDOM(line)).height,
      };
    });

    expect(rule.widget, 'the rule element itself').toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
    expect(
      rule.line,
      'the LINE holding the rule — CM6 sizes the line block, not the widget element, so a ' +
        'block-level widget between the two cm-widgetBuffer elements adds two stray line boxes',
    ).toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
    expect(rule.block, "CM6's height map for that line").toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
  });

  test("clicking a table's spacing band puts the caret on the neighbouring line", async ({
    page,
  }) => {
    await openNote(page, 'Spacing band', WIDGET_HEAVY_NOTE);

    const bands = await page.evaluate(() => {
      const root = document.querySelector('.sf-table') as HTMLElement;
      const table = root.querySelector('table') as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        above: { x: tableRect.right - 20, y: (rootRect.top + tableRect.top) / 2 },
        below: { x: tableRect.right - 20, y: (tableRect.bottom + rootRect.bottom) / 2 },
        hasBandAbove: tableRect.top - rootRect.top > 2,
        hasBandBelow: rootRect.bottom - tableRect.bottom > 2,
      };
    });

    expect(bands.hasBandAbove && bands.hasBandBelow, 'the table has a spacing band to click').toBe(
      true,
    );

    const clickAndReadLine = async (point: { x: number; y: number }) => {
      await page.evaluate(() => {
        const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
        view.focus();
        view.dispatch({ selection: { anchor: 0 } });
      });
      await page.mouse.click(point.x, point.y);
      return page.evaluate(() => {
        const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
        return view.state.doc.lineAt(view.state.selection.main.head).number;
      });
    };

    expect(
      await clickAndReadLine(bands.below),
      'the blank line after the first table (its spacing is padding, so the band ' +
        'belongs to the widget and CM6 would otherwise swallow the click)',
    ).toBe(27);
    expect(await clickAndReadLine(bands.above), 'the blank line before the first table').toBe(23);
  });
});
