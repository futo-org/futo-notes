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
  '> ---',
  '',
  '   ---',
  '',
  `![dot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)`,
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
  test('every rendered block measures the space it occupies @webkit-pointer', async ({ page }) => {
    await openNote(page, 'Height map', WIDGET_HEAVY_NOTE);

    const { drifted, measuredLines, viewportCoversDocument } = await readHeightMap(page);

    const rendered = await page.evaluate(() => ({
      tables: document.querySelectorAll('.sf-table').length,
      rules: document.querySelectorAll('.cm-md-hr-widget').length,
      images: document.querySelectorAll('.cm-md-image-wrapper').length,
    }));
    expect(rendered, 'the fixture really rendered every widget kind it claims to cover').toEqual({
      tables: 2,
      rules: 3,
      images: 1,
    });
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

  test('every rule line measures the height the widget estimates, under any font metrics @webkit-pointer', async ({
    page,
  }) => {
    await openNote(page, 'Rule estimate', WIDGET_HEAVY_NOTE);

    const measureRules = () =>
      page.evaluate(() => {
        const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
        return Array.from(document.querySelectorAll('.cm-md-hr-widget')).map((element) => {
          const widget = element as HTMLElement;
          const line = widget.closest('.cm-line') as HTMLElement;
          const widgetRect = widget.getBoundingClientRect();
          const lineRect = line.getBoundingClientRect();
          return {
            source: view.state.doc.lineAt(view.posAtDOM(line)).text,
            widget: widgetRect.height,
            line: lineRect.height,
            block: view.lineBlockAt(view.posAtDOM(line)).height,
            overflow: line.scrollHeight - line.clientHeight,
            widgetOffsetInLine: widgetRect.top - lineRect.top,
            widthRatio: widgetRect.width / line.clientWidth,
            horizontalOverflow: line.scrollWidth - line.clientWidth,
          };
        });
      });

    for (const metrics of [null, 'line-height: 120px', 'font-size: 40px']) {
      if (metrics) {
        await page.addStyleTag({
          content: `.cm-content, .cm-content .cm-line { ${metrics} !important; }`,
        });
        await settleHeightMap(page);
      }
      const rules = await measureRules();
      const under = metrics ? `under ${metrics}` : "with the shell's own metrics";

      expect(rules.length, `at least one rule is rendered ${under}`).toBeGreaterThan(0);
      if (!metrics) {
        expect(rules.length, 'plain, quoted and indented thematic breaks all render').toBe(3);
      }
      for (const rule of rules) {
        const where = `"${rule.source}" ${under}`;
        expect(rule.widget, `the rule element for ${where}`).toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
        expect(rule.line, `the LINE holding ${where}`).toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
        expect(rule.block, `CM6 height map for ${where}`).toBe(HORIZONTAL_RULE_ESTIMATED_HEIGHT);
        expect(rule.overflow, `content overflowing the line for ${where}`).toBeLessThanOrEqual(1);
        expect(
          rule.widgetOffsetInLine,
          `the rule pushed down inside its own line for ${where}`,
        ).toBeLessThanOrEqual(1);
        expect(
          rule.widthRatio,
          `the rule spans its line rather than shrinking to fit for ${where}`,
        ).toBeGreaterThan(0.9);
        expect(
          rule.horizontalOverflow,
          `the rule overflowing its line sideways for ${where}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test('a revealed rule line keeps a normal text height', async ({ page }) => {
    await openNote(page, 'Rule revealed', WIDGET_HEAVY_NOTE);

    const revealed = await page.evaluate(() => {
      const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
      const lineNumber = view.state.doc.toString().split('\n').indexOf('---') + 1;
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).from + 1 } });
      const at = view.domAtPos(view.state.doc.line(lineNumber).from);
      const node = at.node.nodeType === 1 ? at.node : at.node.parentElement;
      const line = (node as HTMLElement).closest('.cm-line') as HTMLElement;
      return { text: line.textContent, height: line.getBoundingClientRect().height };
    });

    expect(revealed.text, 'the caret on the rule line reveals its source').toBe('---');
    expect(revealed.height, 'the revealed source keeps a normal text height').toBeGreaterThan(10);
  });

  test('shift-clicking the spacing band extends the selection instead of dropping it', async ({
    page,
  }) => {
    await openNote(page, 'Band shift', WIDGET_HEAVY_NOTE);

    const band = await page.evaluate(() => {
      const root = document.querySelector('.sf-table') as HTMLElement;
      const table = root.querySelector('table') as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const view = (window as unknown as { __cmGetView: () => any }).__cmGetView();
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: 7 } });
      return { x: tableRect.right - 20, y: (tableRect.bottom + rootRect.bottom) / 2 };
    });

    await page.keyboard.down('Shift');
    await page.mouse.click(band.x, band.y);
    await page.keyboard.up('Shift');

    const selection = await page.evaluate(() => {
      const { main } = (window as unknown as { __cmGetView: () => any }).__cmGetView().state
        .selection;
      return { anchor: main.anchor, empty: main.empty };
    });

    expect(selection.empty, 'shift-click must not collapse what was already selected').toBe(false);
    expect(selection.anchor, 'the original anchor survives').toBe(0);
  });

  test('clicking above a table that opens the note leaves it rendered', async ({ page }) => {
    const tableFirst = ['| A | B |', '| --- | --- |', '| x | y |', '', 'after', ''].join('\n');
    await openNote(page, 'Table first', tableFirst);

    const point = await page.evaluate(() => {
      const root = document.querySelector('.sf-table') as HTMLElement;
      const table = root.querySelector('table') as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return { x: tableRect.right - 20, y: (rootRect.top + tableRect.top) / 2 };
    });
    await page.mouse.click(point.x, point.y);

    const state = await page.evaluate(() => ({
      tables: document.querySelectorAll('.sf-table').length,
      visible: (document.querySelector('.cm-content') as HTMLElement).innerText.replace(
        /\s+/g,
        ' ',
      ),
    }));

    expect(state.tables, 'the table stays rendered rather than flipping to its source').toBe(1);
    expect(state.visible, 'no raw pipe syntax is revealed').not.toContain('| --- |');
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

    const lines = WIDGET_HEAVY_NOTE.split('\n');
    const headerLine = lines.indexOf('| A | B |') + 1;
    expect(headerLine, 'the fixture still contains the first table').toBeGreaterThan(0);
    let tableLines = 0;
    while (lines[headerLine - 1 + tableLines]?.startsWith('|')) tableLines += 1;

    expect(
      await clickAndReadLine(bands.below),
      'the blank line after the first table (its spacing is padding, so the band ' +
        'belongs to the widget and CM6 would otherwise swallow the click)',
    ).toBe(headerLine + tableLines);
    expect(await clickAndReadLine(bands.above), 'the blank line before the first table').toBe(
      headerLine - 1,
    );
  });
});
