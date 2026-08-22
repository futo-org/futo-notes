import { test, expect, Page } from '@playwright/test';

/**
 * Coverage for the Crepe-style editor UX additions:
 *  - floating selection toolbar
 *  - slash command menu
 *  - block gutter handle
 *  - interactive table editor
 */

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
    view.focus();
  }, content);
  await page.waitForTimeout(200);
}

async function getDocText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__cmGetView?.()?.state.doc.toString() ?? '');
}

async function selectRange(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const view = (window as any).__cmGetView?.();
      if (!view) return;
      view.dispatch({ selection: { anchor: from, head: to } });
      view.focus();
    },
    { from, to },
  );
  await page.waitForTimeout(60);
}

async function setCursor(page: Page, pos: number): Promise<void> {
  await page.evaluate((pos) => {
    const view = (window as any).__cmGetView?.();
    if (!view) return;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, pos);
  await page.waitForTimeout(60);
}

async function selectionToolbarReceivesHitAtCenter(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const toolbarElement = document.querySelector('.sf-selection-toolbar');
    if (!(toolbarElement instanceof HTMLElement)) {
      throw new Error('Selection toolbar not found');
    }
    const rect = toolbarElement.getBoundingClientRect();
    const hitElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!(hitElement instanceof Element)) {
      throw new Error('No element found at selection toolbar center');
    }
    return hitElement.closest('.sf-selection-toolbar') !== null;
  });
}

// ============================================================================
// SELECTION TOOLBAR
// ============================================================================

test.describe('Selection toolbar', () => {
  test('appears on non-empty selection, hides on empty', async ({ page }) => {
    await setupEditor(page, 'hello world');
    await selectRange(page, 0, 5);

    const toolbar = page.locator('.sf-selection-toolbar').first();
    await expect(toolbar).toBeVisible();

    await setCursor(page, 0);
    await expect(toolbar).toBeHidden();
  });

  test('stacks below blocking overlays', async ({ page }) => {
    await setupEditor(page, 'hello world');
    await selectRange(page, 0, 5);

    const toolbar = page.locator('.sf-selection-toolbar').first();
    await expect(toolbar).toBeVisible();

    await page.locator('.sidebar-settings-btn').click();
    await expect(page.locator('.settings-title')).toBeVisible();
    expect(await selectionToolbarReceivesHitAtCenter(page)).toBe(false);

    await page.getByRole('button', { name: 'Close settings' }).click();
    await selectRange(page, 0, 5);
    await page.getByRole('button', { name: 'Note options' }).click();
    await page.getByTestId('note-menu-move').click();
    await expect(page.locator('.modal-title')).toHaveText('Move to folder');
    expect(await selectionToolbarReceivesHitAtCenter(page)).toBe(false);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await selectRange(page, 0, 5);
    await page.getByTestId('new-folder-btn').click();
    await expect(page.getByTestId('create-folder-input')).toBeVisible();
    expect(await selectionToolbarReceivesHitAtCenter(page)).toBe(false);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await selectRange(page, 0, 5);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByPlaceholder('Search notes...')).toBeVisible();
    expect(await selectionToolbarReceivesHitAtCenter(page)).toBe(false);
  });

  test('editor focus state follows CodeMirror focus', async ({ page }) => {
    await setupEditor(page, 'hello world');

    await expect(page.locator('.note-body')).toHaveAttribute('data-editor-focused', '');

    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      view?.contentDOM.blur();
    });

    await expect(page.locator('.note-body')).not.toHaveAttribute('data-editor-focused', '');
  });

  test('bold button wraps selection in **', async ({ page }) => {
    await setupEditor(page, 'hello world');
    await selectRange(page, 0, 5);

    const toolbar = page.locator('.sf-selection-toolbar').first();
    await expect(toolbar).toBeVisible();
    await toolbar.locator('button[aria-label="Bold"]').click();

    expect(await getDocText(page)).toBe('**hello** world');
  });

  test('italic button wraps selection in *', async ({ page }) => {
    await setupEditor(page, 'hello');
    await selectRange(page, 0, 5);
    const toolbar = page.locator('.sf-selection-toolbar').first();
    await toolbar.locator('button[aria-label="Italic"]').click();
    expect(await getDocText(page)).toBe('*hello*');
  });

  test('inline code button wraps selection in backticks', async ({ page }) => {
    await setupEditor(page, 'abc def');
    await selectRange(page, 0, 3);
    const toolbar = page.locator('.sf-selection-toolbar').first();
    await toolbar.locator('button[aria-label="Inline code"]').click();
    expect(await getDocText(page)).toBe('`abc` def');
  });

  test('does not appear for multi-line selection', async ({ page }) => {
    await setupEditor(page, 'line one\nline two');
    await selectRange(page, 0, 14);
    const toolbar = page.locator('.sf-selection-toolbar');
    await expect(toolbar).toHaveCount(0);
  });

  // Regression: the selection toolbar is a DESKTOP feature and must NOT show
  // inside the native iOS/Android WebView embed (editor.html mounts
  // MarkdownEditor with nativeShell:true). It leaked back onto the native apps
  // because the gate keyed on `isMobile`, which is a Tauri-only flag that is
  // false in the native WebView. See MarkdownEditor.svelte selectionToolbar gate.
  test('stays hidden in the native embed (nativeShell)', async ({ page }) => {
    await page.goto('/editor.html');
    await page.waitForSelector('.cm-editor', { timeout: 10000 });
    await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'hello world' },
        selection: { anchor: 0, head: 5 },
      });
      view.focus();
    });
    await page.waitForTimeout(200);
    await expect(page.locator('.sf-selection-toolbar')).toHaveCount(0);
  });
});

// ============================================================================
// POINTER SELECTION (marker snapping)
// ============================================================================

// Fire the synthetic mouse-drag sequence WebKit/Chromium emit around a pointer
// selection (mousedown on the content → mousemove past the 3px drag threshold →
// mouseup), so the pointer-selection settle runs and `snapSelectionPastMarkdownMarkers`
// gets a chance to re-dispatch the selection.
async function fireDragSelect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const dom = view.dom as HTMLElement;
    const r = dom.getBoundingClientRect();
    const x = r.left + 5;
    const y = r.top + 5;
    dom.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent('mousemove', { button: 0, clientX: x + 20, clientY: y, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent('mouseup', { button: 0, clientX: x + 20, clientY: y, bubbles: true }),
    );
  });
  // Snapping is scheduled on a 0ms timeout after mouseup
  // (schedulePointerSelectionSettle). Queue our own macrotask BEHIND it —
  // when this resolves, the snap (if any) has already run. No fixed wait.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function getSelection(page: Page): Promise<{ from: number; to: number } | null> {
  return page.evaluate(() => {
    const s = (window as any).__cmGetView?.()?.state.selection.main;
    return s ? { from: s.from, to: s.to } : null;
  });
}

test.describe('Pointer selection (marker snapping)', () => {
  // Desktop: dragging a selection over the visible content of a markdown element
  // whose source markers are hidden extends the selection through those markers,
  // so copy/delete carry valid markdown. This is a MOUSE affordance.
  test('desktop drag-select snaps through hidden markers', async ({ page }) => {
    await setupEditor(page, '**hello**');
    await selectRange(page, 2, 7); // inner "hello", markers hidden
    await fireDragSelect(page);
    expect(await getSelection(page)).toEqual({ from: 0, to: 9 });
  });

  // Regression: the native iOS/Android WebView (editor.html, nativeShell:true)
  // must leave text selection entirely to the system. The pointer-selection
  // listeners keyed on synthetic mouse events, which WebKit also emits for touch
  // gestures — so we were re-dispatching the selection out from under the user's
  // native grab handles. They are now desktop-only; the selection must stay put.
  // See editorPointerInteractions' desktop-only reveal and snapping policy.
  test('native embed leaves selection to the system (nativeShell)', async ({ page }) => {
    await page.goto('/editor.html');
    await page.waitForSelector('.cm-editor', { timeout: 10000 });
    await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '**hello**' },
        selection: { anchor: 2, head: 7 },
      });
      view.focus();
    });
    // dispatch/focus are synchronous — wait only for the selection to be
    // observable, then fire the drag.
    await page.waitForFunction(() => {
      const s = (window as any).__cmGetView?.()?.state.selection.main;
      return s && s.from === 2 && s.to === 7;
    });
    await fireDragSelect(page);
    // Unchanged — no programmatic snapping fought the native selection.
    expect(await getSelection(page)).toEqual({ from: 2, to: 7 });
  });
});

// ============================================================================
// CLICKING PAST THE END OF A LINE
// ============================================================================

const WRAPPING_LINE =
  'The quick brown fox jumps over the lazy dog and keeps running far past the ' +
  'edge of the column so this line wraps onto a second row.';

/**
 * A wrapped line whose LAST row is narrower than an earlier one and ends in a
 * wikilink, so the rendered row stops at `Tests` while `line.to` sits after the
 * hidden `]]`.
 */
const WRAPPING_WIKILINK_LINE =
  'Clicking past the end of this wrapped paragraph should put the caret right ' +
  'after the link, because the hidden closing brackets stop the drawn row short ' +
  'of the text it stands for, and the answer is the end of the line: ' +
  '[[Wrapping Tests]]';

/** The client rects of each VISUAL row of the first line, top row first. */
async function rowsOfFirstLine(
  page: Page,
): Promise<{ top: number; bottom: number; right: number }[]> {
  return page.evaluate(() => {
    const line = document.querySelector('.cm-line') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(line);
    return [...range.getClientRects()].map((r) => ({
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
    }));
  });
}

/** Where the caret is drawn, plus the first line's end for comparison. */
async function caretState(page: Page) {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView();
    const drawn = document.querySelector('.cm-cursor')?.getBoundingClientRect();
    return {
      head: view.state.selection.main.head,
      firstLineTo: view.state.doc.line(1).to,
      drawnTop: drawn ? Math.round(drawn.top) : null,
      drawnLeft: drawn ? Math.round(drawn.left) : null,
    };
  });
}

test.describe('Clicking past the end of a line', () => {
  test('a click past the text on a wrapped row keeps the caret on that row', async ({ page }) => {
    await setupEditor(page, `${WRAPPING_LINE}\nsecond markdown line`);
    const rows = await rowsOfFirstLine(page);
    // Precondition: the line wraps, and the clicked row is not its last.
    expect(rows.length).toBeGreaterThan(1);
    const row = rows[0];
    await setCursor(page, 0);

    await page.mouse.click(row.right + 8, Math.round((row.top + row.bottom) / 2));
    await page.waitForTimeout(100);

    const caret = await caretState(page);
    expect(caret.drawnTop).toBeGreaterThanOrEqual(row.top - 2);
    expect(caret.drawnTop).toBeLessThan(row.bottom);
    expect(caret.head).toBeLessThan(caret.firstLineTo);
  });

  test('a click past the text on an unwrapped line lands at its end', async ({ page }) => {
    await setupEditor(page, 'short line\nsecond markdown line');
    const rows = await rowsOfFirstLine(page);
    expect(rows).toHaveLength(1);
    await setCursor(page, 0);

    await page.mouse.click(rows[0].right + 120, Math.round((rows[0].top + rows[0].bottom) / 2));
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 10, to: 10 });
  });

  // Same wrap point as above, but out in the gutter rather than over the text.
  test(
    'a click in the blank space beside a wrapped row keeps the caret on that row',
    { tag: '@webkit-pointer' },
    async ({ page }) => {
      await setupEditor(page, WRAPPING_LINE);
      const rows = await rowsOfFirstLine(page);
      expect(rows.length).toBeGreaterThan(1);
      const row = rows[0];
      await setCursor(page, 0);

      const widest = Math.max(...rows.map((r) => r.right));
      const x = await page.evaluate(
        ({ widest }) => Math.round(widest + (window as any).__cmGetView().defaultLineHeight),
        { widest },
      );
      const y = Math.round((row.top + row.bottom) / 2);
      // Precondition: past the drawn text of every row, inside the surface.
      expect(
        await page.evaluate(
          ({ x }) => {
            const content = document.querySelector('.cm-content')!.getBoundingClientRect();
            return x < content.right;
          },
          { x },
        ),
      ).toBe(true);

      await page.mouse.click(x, y);
      await page.waitForTimeout(100);

      const caret = await caretState(page);
      expect(caret.drawnTop).toBeGreaterThanOrEqual(row.top - 2);
      expect(caret.drawnTop).toBeLessThan(row.bottom);
    },
  );

  // "Past the text" is decided against the pointer's OWN row. Judged across the
  // whole line it would take the widest row, and this click would fall through
  // to the engine into the wikilink's hidden `]]`, splitting it on the next key.
  test('a click past a last row ending in a wikilink lands after the link', async ({ page }) => {
    await setupEditor(page, WRAPPING_WIKILINK_LINE);
    const rows = await rowsOfFirstLine(page);
    const last = rows[rows.length - 1];
    const widest = Math.max(...rows.map((r) => r.right));
    // Preconditions: the line wraps, and the last row is short of the widest.
    expect(rows.length).toBeGreaterThan(1);
    expect(widest).toBeGreaterThan(last.right + 10);
    await setCursor(page, 0);

    await page.mouse.click(
      Math.round((last.right + widest) / 2),
      Math.round((last.top + last.bottom) / 2),
    );
    await page.waitForTimeout(100);

    const caret = await caretState(page);
    expect(caret.head).toBe(caret.firstLineTo);
  });
});

// ============================================================================
// THE BLANK SPACE AROUND THE NOTE
// ============================================================================

/**
 * The note's boxes: the editor's whole surface — `.cm-content`, as wide as the
 * lines' own padding makes it — the text DRAWN inside it, and the last row's
 * height. The line boxes span the surface, so only a range over their contents
 * measures the text. → docs/spec/editor.md
 */
async function noteGeometry(page: Page) {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView();
    const surface = document.querySelector('.cm-content')!.getBoundingClientRect();
    const drawn = document.createRange();
    drawn.selectNodeContents(document.querySelector('.cm-line')!);
    const column = drawn.getBoundingClientRect();
    const last = view.coordsAtPos(view.state.doc.length);
    return {
      surface: {
        left: Math.round(surface.left),
        right: Math.round(surface.right),
        bottom: Math.round(surface.bottom),
        visibleBottom: Math.round(Math.min(surface.bottom, window.innerHeight)),
      },
      column: { left: Math.round(column.left), right: Math.round(column.right) },
      lastRowY: Math.round((last.top + last.bottom) / 2),
      lastBottom: Math.round(last.bottom),
    };
  });
}

/** Whose box the point falls in: the editor's own, or the shell's slack around it. */
async function whoseSpace(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return 'nothing';
      if (hit.closest('.cm-editor')) return 'editor';
      if (hit.classList.contains('note-body')) return 'shell';
      return hit.className;
    },
    { x, y },
  );
}

async function editorFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor')));
}

// 'first line' spans 0..10, 'second line' 11..22.
const TWO_LINES = 'first line\nsecond line';

test.describe('The blank space around the note', { tag: '@webkit-pointer' }, () => {
  for (const [side, dx, expected] of [
    ['left', 10, 11],
    ['right', -10, 22],
  ] as const) {
    test(`a click beside a line lands at its ${side === 'left' ? 'start' : 'end'}`, async ({
      page,
    }) => {
      await setupEditor(page, TWO_LINES);
      const geo = await noteGeometry(page);
      const x = side === 'left' ? geo.surface.left + dx : geo.surface.right + dx;
      await setCursor(page, 0);
      expect(await whoseSpace(page, x, geo.lastRowY)).toBe('editor');

      await page.mouse.click(x, geo.lastRowY);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: expected, to: expected });
      expect(await editorFocused(page)).toBe(true);
    });
  }

  test('a drag that starts beside the text selects it', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const target = await page.evaluate(() => {
      const coords = (window as any).__cmGetView().coordsAtPos(18);
      return { x: Math.round(coords.left), y: Math.round((coords.top + coords.bottom) / 2) };
    });
    await setCursor(page, 0);

    await page.mouse.move(geo.surface.left + 10, geo.lastRowY);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 11, to: 18 });
  });

  test('a double-click beside the text takes the nearest word', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    await setCursor(page, 0);

    await page.mouse.dblclick(geo.surface.left + 10, geo.lastRowY);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 11, to: 17 }); // 'second'
  });

  test('a shift-click beside the text extends the selection', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    await setCursor(page, 13);

    await page.keyboard.down('Shift');
    await page.mouse.click(geo.surface.right - 10, geo.lastRowY);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 13, to: 22 });
  });

  test('a click below the text lands on the character under the pointer', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const coords = view.coordsAtPos(16); // mid-word on the last line
      return { x: Math.round(coords.left), onLinePos: 16 };
    });
    const y = geo.lastBottom + 40;
    await setCursor(page, 0);
    // Preconditions: below every line, inside the surface, and not the note's end.
    expect(y).toBeLessThan(geo.surface.bottom);
    expect(await whoseSpace(page, probe.x, y)).toBe('editor');

    await page.mouse.click(probe.x, y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 16, to: 16 });
    expect(await editorFocused(page)).toBe(true);
  });

  test('the caret is already right while the button is still down', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const x = await page.evaluate(() =>
      Math.round((window as any).__cmGetView().coordsAtPos(16).left),
    );
    await setCursor(page, 0);

    await page.mouse.move(x, geo.lastBottom + 40);
    await page.mouse.down();
    await page.waitForTimeout(80);
    const duringPress = await getSelection(page);
    await page.mouse.up();
    await page.waitForTimeout(80);

    expect(duringPress).toEqual({ from: 16, to: 16 });
    expect(await getSelection(page)).toEqual({ from: 16, to: 16 });
  });

  test('a click well below the text lands at the end of the note', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const end = view.coordsAtPos(view.state.doc.length, -1);
      return {
        x: Math.round(view.coordsAtPos(16).left), // a column the note's end is not at
        justBelow: Math.round(end.bottom + view.defaultLineHeight),
        wellBelow: Math.round(end.bottom + view.defaultLineHeight * 3),
      };
    });
    const geo = await noteGeometry(page);
    expect(probe.wellBelow).toBeLessThan(geo.surface.bottom);

    await setCursor(page, 0);
    await page.mouse.click(probe.x, probe.justBelow);
    await page.waitForTimeout(100);
    expect(await getSelection(page)).toEqual({ from: 16, to: 16 });

    await setCursor(page, 0);
    await page.mouse.click(probe.x, probe.wellBelow);
    await page.waitForTimeout(100);
    expect(await getSelection(page)).toEqual({ from: 22, to: 22 });
  });

  test('a double-click below the text takes the word under the pointer', async ({ page }) => {
    await setupEditor(page, 'alpha bravo charlie.\nsecond line of words here.');
    const geo = await noteGeometry(page);
    const x = await page.evaluate(() =>
      Math.round((window as any).__cmGetView().coordsAtPos(34).left),
    );
    await setCursor(page, 0);

    await page.mouse.dblclick(x, geo.lastBottom + 40);
    await page.waitForTimeout(100);

    const selected = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const range = view.state.selection.main;
      return view.state.doc.sliceString(range.from, range.to);
    });
    expect(selected).toBe('of');
  });

  test('a drag that starts below the text selects from there', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const start = view.coordsAtPos(16);
      const target = view.coordsAtPos(5);
      return {
        x: Math.round(start.left),
        targetX: Math.round(target.left),
        targetY: Math.round((target.top + target.bottom) / 2),
      };
    });
    await setCursor(page, 0);

    await page.mouse.move(probe.x, geo.lastBottom + 40);
    await page.mouse.down();
    await page.mouse.move(probe.targetX, probe.targetY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 5, to: 16 });
  });

  // Both notes end in markup a keystroke would corrupt if the caret landed in it.
  for (const [ending, doc, expected] of [
    ['a wikilink', 'intro\nsee [[Some Note]]', 23],
    ['a code fence', 'intro\n\n```js\nconst a = 1;\n```', 29],
  ] as const) {
    test(`a click below a note ending in ${ending} lands at the end of the note`, async ({
      page,
    }) => {
      await setupEditor(page, doc);
      const geo = await noteGeometry(page);
      const y = geo.lastBottom + 40;
      const x = geo.surface.right - 10; // below the text and past what it draws
      await setCursor(page, 0);
      expect(await getDocText(page)).toHaveLength(expected);
      expect(await whoseSpace(page, x, y)).toBe('editor');

      await page.mouse.click(x, y);
      await page.waitForTimeout(100);
      await page.keyboard.type('X');
      await page.waitForTimeout(100);

      expect(await getDocText(page)).toBe(`${doc}X`);
    });
  }

  for (const [side, dx] of [
    ['left', -20],
    ['right', 20],
  ] as const) {
    test(`a click past the surface on the ${side} deselects the note`, async ({ page }) => {
      await setupEditor(page, TWO_LINES);
      const geo = await noteGeometry(page);
      const x = side === 'left' ? geo.surface.left + dx : geo.surface.right + dx;
      await setCursor(page, 5);
      expect(await whoseSpace(page, x, geo.lastRowY)).toBe('shell');

      await page.mouse.click(x, geo.lastRowY);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
      expect(await editorFocused(page)).toBe(false);
    });
  }

  // Chromium never hijacks a press out here, so only webkit-pointer proves these.
  for (const [side, dx] of [
    ['left', -20],
    ['right', 20],
  ] as const) {
    test(`a press past the surface on the ${side} deselects even with hand jitter`, async ({
      page,
    }) => {
      await setupEditor(page, TWO_LINES);
      const geo = await noteGeometry(page);
      const x = side === 'left' ? geo.surface.left + dx : geo.surface.right + dx;
      await setCursor(page, 5);

      await page.mouse.move(x, geo.lastRowY);
      await page.mouse.down();
      await page.mouse.move(x + 2, geo.lastRowY + 1);
      await page.mouse.up();
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
      expect(await editorFocused(page)).toBe(false);
    });
  }

  test('a drag from past the surface into the text selects nothing', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const target = await page.evaluate(() => {
      const coords = (window as any).__cmGetView().coordsAtPos(18);
      return { x: Math.round(coords.left), y: Math.round((coords.top + coords.bottom) / 2) };
    });
    await setCursor(page, 5);

    await page.mouse.move(geo.surface.left - 20, geo.lastRowY);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
    expect(await editorFocused(page)).toBe(false);
  });

  // The edge is one straight line, so the answer cannot depend on the height.
  test('the surface edge deselects at every height', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    const geo = await noteGeometry(page);
    const x = geo.surface.left - 20;

    for (const y of [
      geo.lastRowY - 30,
      geo.lastRowY,
      geo.lastBottom + 40,
      geo.surface.visibleBottom - 20,
    ]) {
      await setCursor(page, 5);
      expect(await whoseSpace(page, x, y)).toBe('shell');

      await page.mouse.click(x, y);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
      expect(await editorFocused(page)).toBe(false);
    }
  });

  // The hidden `]]` stops the drawn row short of the line it stands for.
  test('a click beside a line ending in a wikilink lands after the link', async ({ page }) => {
    await setupEditor(page, 'see [[Some Note]]\nnext line');
    const geo = await noteGeometry(page);
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const line = document.querySelector('.cm-line')!;
      const box = line.getBoundingClientRect();
      const drawn = document.createRange();
      drawn.selectNodeContents(line);
      return {
        x: Math.round(drawn.getBoundingClientRect().right + 40),
        y: Math.round((box.top + box.bottom) / 2),
        lineTo: view.state.doc.line(1).to,
      };
    });
    await setCursor(page, 0);
    // Preconditions: past the drawn row, inside the editor, and `]]` is hidden.
    expect(probe.x).toBeGreaterThan(geo.column.right);
    expect(probe.x).toBeLessThan(geo.surface.right);
    expect(await getDocText(page)).toContain(']]');

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: probe.lineTo, to: probe.lineTo });
  });

  test('the tag bar slack reaches into the first line', async ({ page }) => {
    await setupEditor(page, 'alpha bravo charlie delta');
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const bar = document.querySelector('.note-tag-bar')!.getBoundingClientRect();
      const addBtn = document.querySelector('.tag-add-btn')!.getBoundingClientRect();
      const x = Math.round(view.coordsAtPos(12).left);
      const y = Math.round(bar.top + bar.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        clearOfTheButton: x > addBtn.right + 10,
        hitsBarItself: Boolean(hit && hit.classList.contains('note-tag-bar')),
        // The column resolved on the first line, which the tap must reproduce.
        onLinePos: view.posAtCoords(
          { x, y: (view.coordsAtPos(0).top + view.coordsAtPos(0).bottom) / 2 },
          false,
        ),
      };
    });
    await setCursor(page, 0);
    expect(probe.clearOfTheButton).toBe(true);
    expect(probe.hitsBarItself).toBe(true);
    expect(probe.onLinePos).toBeGreaterThan(0);

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: probe.onLinePos, to: probe.onLinePos });
    expect(await editorFocused(page)).toBe(true);
  });

  // A hidden header tag block renders `display: none`, so the slack has to reach
  // past it to the first visible line.
  test('the tag bar slack never reaches into a hidden header tag block', async ({ page }) => {
    await setupEditor(page, '#work #ideas\n\nbody text line here');
    const probe = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      view.contentDOM.blur(); // a caret in the block would reveal it on its own
      const bar = document.querySelector('.note-tag-bar')!.getBoundingClientRect();
      const addBtn = document.querySelector('.tag-add-btn')!.getBoundingClientRect();
      const lines = [...document.querySelectorAll('.cm-line')];
      return {
        x: Math.round(addBtn.right + 60),
        y: Math.round(bar.top + bar.height / 2),
        pills: [...document.querySelectorAll('.tag-pill-name')].map((p) => p.textContent),
        blockHidden: lines[0].getBoundingClientRect().height === 0,
        // 'body text line here' begins here; anything below is inside the block.
        bodyStart: view.state.doc.line(3).from,
      };
    });
    // Preconditions: the tags are pills and the markup is hidden.
    expect(probe.pills).toEqual(['work', 'ideas']);
    expect(probe.blockHidden).toBe(true);

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      return {
        caret: view.state.selection.main.head,
        blockStillHidden: document.querySelector('.cm-line')!.getBoundingClientRect().height === 0,
      };
    });
    expect(after.caret).toBeGreaterThanOrEqual(probe.bodyStart);
    expect(after.blockStillHidden).toBe(true);
  });

  // Every candidate position sits in hidden markup, where a keystroke would
  // corrupt a tag (`#ideas` + "hello" → `#ideashello`).
  test('a note that is only a hidden tag block has nothing to land on', async ({ page }) => {
    await setupEditor(page, '#work #ideas');
    // The block only collapses once the editor is blurred.
    await page.evaluate(() => (window as any).__cmGetView().contentDOM.blur());
    await page.waitForFunction(
      () => document.querySelector('.cm-line')!.getBoundingClientRect().height === 0,
    );

    const probe = await page.evaluate(() => {
      const content = document.querySelector('.cm-content')!.getBoundingClientRect();
      return {
        x: Math.round(content.left + 80),
        y: Math.round(content.top + 40),
        tailY: Math.round(content.bottom - 20),
        pills: [...document.querySelectorAll('.tag-pill-name')].map((p) => p.textContent),
        noVisibleLine: [...document.querySelectorAll('.cm-line')].every(
          (l) => l.getBoundingClientRect().height === 0,
        ),
      };
    });
    // Precondition: the whole doc is the hidden block.
    expect(probe.pills).toEqual(['work', 'ideas']);
    expect(probe.noVisibleLine).toBe(true);
    expect(await whoseSpace(page, probe.x, probe.y)).toBe('editor');
    expect(await whoseSpace(page, probe.x, probe.tailY)).toBe('editor');

    for (const y of [probe.y, probe.tailY]) {
      await page.mouse.click(probe.x, y);
      await page.waitForTimeout(100);
      await page.keyboard.type('hello');
      await page.waitForTimeout(100);
    }

    expect(await getDocText(page)).toBe('#work #ideas');
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('.tag-pill-name')].map((p) => p.textContent),
      ),
    ).toEqual(['work', 'ideas']);
  });

  // The title input is the sharpest case: a preventDefault on a hijacked mousedown
  // would stop it focusing at all.
  test('the surrounding chrome keeps its own clicks', async ({ page }) => {
    await setupEditor(page, 'first line');
    await setCursor(page, 5);

    await page.locator('.title-input').click();
    await expect(page.locator('.title-input')).toBeFocused();
    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });

    // The Add button sits in the tag bar, so only the target check keeps this
    // click; a hijack still reaches `startAdding`, so watch the body caret.
    await page.locator('.tag-add-btn').click();
    await expect(page.locator('.tag-input')).toBeFocused();
    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
  });

  // A line that takes the gutter as margin must drop it from its padding, or
  // its text starts one gutter further in than every plain line.
  test('a decorated line uses the same text width as a plain one', async ({ page }) => {
    await setupEditor(page, 'plain paragraph\n\n> quoted paragraph\n\n```js\ncode line\n```');
    await setCursor(page, 0);
    await page.waitForTimeout(100);

    const edges = await page.evaluate(() => {
      const textRight = (el: Element) =>
        Math.round(
          el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight),
        );
      const boxRight = (el: Element) => Math.round(el.getBoundingClientRect().right);
      const find = (cls: string) => document.querySelector(`.cm-line.${cls}`)!;
      const plain = [...document.querySelectorAll('.cm-line')].find(
        (l) => !l.className.includes('cm-md-'),
      )!;
      return {
        plainText: textRight(plain),
        quoteText: textRight(find('cm-md-quote')),
        codeBox: boxRight(find('cm-md-code-block')),
      };
    });

    expect(edges.quoteText).toBe(edges.plainText);
    expect(edges.codeBox).toBe(edges.plainText);
  });

  // Probed inside the surface's x band, so the side edge cannot be what rejects it.
  test('a click above the tag bar deselects the note', async ({ page }) => {
    await setupEditor(page, TWO_LINES);
    await setCursor(page, 5);

    const point = await page.evaluate(() => {
      const surface = document.querySelector('.cm-content')!.getBoundingClientRect();
      const bar = document.querySelector('.note-tag-bar')!.getBoundingClientRect();
      return { x: Math.round(surface.left + 10), y: Math.round(bar.top - 6) };
    });
    expect(await whoseSpace(page, point.x, point.y)).toBe('shell');

    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
    expect(await editorFocused(page)).toBe(false);
  });
});

// ============================================================================
// SLASH MENU
// ============================================================================

test.describe('Slash menu', () => {
  test('opens when `/` is typed on an empty line and filters', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/');

    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeVisible();
    // All commands visible initially
    const items = menu.locator('.sf-slash-menu__item');
    expect(await items.count()).toBeGreaterThan(5);

    await page.keyboard.type('head');
    // "Heading 1" should be first
    const first = menu.locator('.sf-slash-menu__item').first();
    await expect(first).toHaveAttribute('data-command-id', 'heading-1');
  });

  test('Enter commits selected command', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('Enter');

    const doc = await getDocText(page);
    expect(doc).toBe('# ');
  });

  test('ArrowDown + Enter commits different command', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('ArrowDown'); // to heading-2
    await page.keyboard.press('Enter');

    expect(await getDocText(page)).toBe('## ');
  });

  test('Escape dismisses without committing', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('Escape');

    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeHidden();
    // The /head text remains
    expect(await getDocText(page)).toBe('/head');
  });

  test('does not open mid-line', async ({ page }) => {
    await setupEditor(page, 'hello');
    await page.locator('.cm-content').focus();
    // Cursor is at end of line
    await page.keyboard.type('/');
    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeHidden();
  });

  test('table command inserts a minimal table', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');

    const doc = await getDocText(page);
    expect(doc).toContain('| Column 1 | Column 2 |');
    expect(doc).toContain('| --- | --- |');
  });

  test('divider command renders the HR widget (regression #10)', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/divider');
    await page.keyboard.press('Enter');
    // Give the decoration a tick to settle
    await page.waitForTimeout(150);

    const hr = page.locator('.cm-md-hr-widget');
    await expect(hr).toBeVisible();
  });
});

// ============================================================================
// TABLE EDITOR
// ============================================================================

test.describe('Table editor', () => {
  // Trailing blank line + text keeps cursor outside the table range so the widget renders.
  const MINIMAL_TABLE = `| A | B |
| --- | --- |
| 1 | 2 |

after`;

  test('cells are contentEditable', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    // Blur CM so the table widget can render
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    const cells = page.locator('.sf-table__cell');
    expect(await cells.count()).toBe(4); // 2 headers + 2 data cells
    const first = cells.first();
    await expect(first).toHaveAttribute('contenteditable', 'true');
  });

  test('typing in a cell syncs back to markdown', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    // Focus the first data cell and type
    await page.evaluate(() => {
      const cells = document.querySelectorAll('.sf-table__cell');
      const dataCell = cells[2] as HTMLElement; // third cell = first data cell
      dataCell.focus();
      const range = document.createRange();
      range.selectNodeContents(dataCell);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type('0');
    // Wait past sync debounce
    await page.waitForTimeout(300);

    const doc = await getDocText(page);
    expect(doc).toContain('| 10 | 2 |');
  });

  test('cell keeps focus across successive keystrokes (regression #11)', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    // Focus first data cell, place caret at end
    await page.evaluate(() => {
      const cells = document.querySelectorAll('.sf-table__cell');
      const dataCell = cells[2] as HTMLElement;
      dataCell.focus();
      const range = document.createRange();
      range.selectNodeContents(dataCell);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Type several characters with the debounce window elapsing between them
    for (const c of 'abcd') {
      await page.keyboard.type(c);
      await page.waitForTimeout(220); // > sync debounce (180ms)
      const focusedIsCell = await page.evaluate(
        () => document.activeElement?.classList.contains('sf-table__cell') ?? false,
      );
      expect(focusedIsCell).toBe(true);
    }
    expect(await getDocText(page)).toContain('| 1abcd | 2 |');
  });
});
