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
  // See MarkdownEditor.svelte's pointer-selection gate (`if (!nativeShell)`).
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

/** Where the caret is actually DRAWN, plus the line end it could have snapped to. */
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
  // A wrapped line is ONE markdown line with several rows on screen, and its
  // `line.to` is the end of the LAST row. Snapping there dropped the caret a row
  // below the click — visibly, right after the engine had placed it correctly.
  test('a click past the text on a wrapped row keeps the caret on that row', async ({ page }) => {
    await setupEditor(page, `${WRAPPING_LINE}\nsecond markdown line`);
    const rows = await rowsOfFirstLine(page);
    // Precondition: the line really does wrap, and the row clicked is not its last.
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

  // The affordance itself: past the text of a line that does NOT wrap, the caret
  // still goes to that line's end rather than the nearest character.
  test('a click past the text on an unwrapped line lands at its end', async ({ page }) => {
    await setupEditor(page, 'short line\nsecond markdown line');
    const rows = await rowsOfFirstLine(page);
    expect(rows).toHaveLength(1);
    await setCursor(page, 0);

    await page.mouse.click(rows[0].right + 120, Math.round((rows[0].top + rows[0].bottom) / 2));
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 10, to: 10 });
  });
});

// ============================================================================
// CLICK IN THE BLANK SPACE AROUND THE NOTE
// ============================================================================

/**
 * The caret follows a click into the blank space only within REACH_IN_LINES of
 * the text (NoteWorkspace.svelte). Each geometry below is expressed in multiples
 * of that reach so the cases stay on the intended side of the boundary.
 * → docs/spec/editor.md
 */
type Probe = {
  x: number;
  y: number;
  onLinePos: number;
  hitsBlankSpace: boolean;
};

/**
 * A click point relative to the text, in units of the editor's reach:
 * `down` from the last line's bottom, `side` from the content column's edge
 * (negative = left). Also reports what a click at the same COLUMN but on the
 * last line resolves to, which is the reference for below-the-text cases.
 */
async function probePoint(
  page: Page,
  { down = 0, side = 0, atPos }: { down?: number; side?: number; atPos?: number },
): Promise<Probe> {
  return page.evaluate(
    ({ down, side, atPos }) => {
      const view = (window as any).__cmGetView();
      const reach = view.defaultLineHeight * 2;
      const content = document.querySelector('.cm-content')!.getBoundingClientRect();
      const last = view.coordsAtPos(view.state.doc.length);

      const x =
        atPos !== undefined
          ? Math.round(view.coordsAtPos(atPos).left)
          : Math.round(side < 0 ? content.left + side * reach : content.right + side * reach);
      const y = Math.round(down > 0 ? last.bottom + down * reach : (last.top + last.bottom) / 2);
      const hit = document.elementFromPoint(x, y);

      return {
        x,
        y,
        onLinePos: view.posAtCoords({ x, y: (last.top + last.bottom) / 2 }, false),
        // Outside the editor's own DOM, i.e. a container the handler owns —
        // otherwise the case would be proving CM's placement, not the handler's.
        hitsBlankSpace: Boolean(hit && !hit.closest('.cm-editor') && hit.closest('.note-body')),
      };
    },
    { down, side, atPos },
  );
}

test.describe('Click in the blank space around the note', () => {
  // Just below the text the column still picks the character, exactly as if the
  // click had landed on the last line.
  test('within reach below the text lands on the same character as the line would', async ({
    page,
  }) => {
    await setupEditor(page, 'alpha bravo charlie delta');
    const probe = await probePoint(page, { down: 0.5, atPos: 12 });
    await setCursor(page, 0);

    expect(probe.hitsBlankSpace).toBe(true);
    // A middle column, so end-of-note would be a visibly different answer.
    expect(probe.onLinePos).toBeGreaterThan(0);
    expect(probe.onLinePos).toBeLessThan(25);

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: probe.onLinePos, to: probe.onLinePos });
  });

  // Past the reach the column stops mattering — the note's end is what's wanted.
  test('beyond reach below the text lands at the end of the note', async ({ page }) => {
    await setupEditor(page, 'alpha bravo charlie delta');
    const probe = await probePoint(page, { down: 2, atPos: 12 });
    await setCursor(page, 0);

    expect(probe.hitsBlankSpace).toBe(true);
    expect(probe.onLinePos).toBeLessThan(25); // same column as the case above

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 25, to: 25 });
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor')))).toBe(
      true,
    );
  });

  // Beside a line, within reach: the near end of THAT line.
  for (const [side, offset, expected] of [
    ['left', -0.5, 11],
    ['right', 0.5, 22],
  ] as const) {
    test(`within reach ${side} of the second line lands at its ${side === 'left' ? 'start' : 'end'}`, async ({
      page,
    }) => {
      await setupEditor(page, 'first line\nsecond line');
      // The doc end sits on the second line, so probePoint's vertical reference
      // is that line. 'first line\nsecond line' — it spans 11..22.
      const probe = await probePoint(page, { side: offset });
      await setCursor(page, 0);
      expect(probe.hitsBlankSpace).toBe(true);

      await page.mouse.click(probe.x, probe.y);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: expected, to: expected });
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor'))),
      ).toBe(true);
    });
  }

  // Far out to either side is a click AWAY from the note: the caret stays where
  // it was and the editor gives up focus.
  for (const [side, offset] of [
    ['left', -2],
    ['right', 2],
  ] as const) {
    test(`beyond reach ${side} of a line clicks off the note`, async ({ page }) => {
      await setupEditor(page, 'first line\nsecond line');
      const probe = await probePoint(page, { side: offset });
      await setCursor(page, 5);
      expect(probe.hitsBlankSpace).toBe(true);

      await page.mouse.click(probe.x, probe.y);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor'))),
      ).toBe(false);
    });
  }

  // The click-off corridor is the SAME at every height. This used to be an L: the
  // side gate was evaluated per vertical zone, so out at the far left, level with
  // a line clicked off while a few px lower jumped to the end of the note.
  test('beyond reach to the side clicks off at every height', async ({ page }) => {
    await setupEditor(page, 'first line\nsecond line');
    const heights = await Promise.all(
      [0, 0.5, 1.5, 3].map((down) => probePoint(page, { side: -2, down })),
    );

    for (const probe of heights) {
      await setCursor(page, 5);
      expect(probe.hitsBlankSpace).toBe(true);

      await page.mouse.click(probe.x, probe.y);
      await page.waitForTimeout(100);

      expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor'))),
      ).toBe(false);
    }
  });

  // The tag bar's slack is the note's topmost strip and used to be a ~31px band of
  // blank space directly above the first line where a click killed the caret.
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
        // The column resolved ON the first line — what the tap has to reproduce.
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
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor')))).toBe(
      true,
    );
  });

  // A note whose header tag block is hidden renders those lines `display: none`,
  // so the tag bar's slack must reach the first VISIBLE line. Reaching position 0
  // instead pops open the raw `#tag` markup the bar exists to replace.
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
    // Preconditions: the tags really are pills and the markup really is hidden.
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

  // A note that is ONLY a tag block has no visible line, so every candidate
  // position sits in the hidden markup. Landing there reveals it and the next
  // keystroke corrupts a tag (`#ideas` + "hello" → `#ideashello`).
  test('a note that is only a hidden tag block has nothing to reach', async ({ page }) => {
    await setupEditor(page, '#work #ideas');
    // setupEditor leaves the caret in the tag line, which reveals it; the block
    // only collapses once the editor is blurred.
    await page.evaluate(() => (window as any).__cmGetView().contentDOM.blur());
    await page.waitForFunction(
      () => document.querySelector('.cm-line')!.getBoundingClientRect().height === 0,
    );

    const probe = await page.evaluate(() => {
      const content = document.querySelector('.cm-content')!.getBoundingClientRect();
      return {
        x: Math.round(content.left + 80),
        y: Math.round(content.top + 40),
        pills: [...document.querySelectorAll('.tag-pill-name')].map((p) => p.textContent),
        noVisibleLine: [...document.querySelectorAll('.cm-line')].every(
          (l) => l.getBoundingClientRect().height === 0,
        ),
      };
    });
    // Preconditions: the whole doc really is the hidden block.
    expect(probe.pills).toEqual(['work', 'ideas']);
    expect(probe.noVisibleLine).toBe(true);

    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(100);
    await page.keyboard.type('hello');
    await page.waitForTimeout(100);

    expect(await getDocText(page)).toBe('#work #ideas');
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('.tag-pill-name')].map((p) => p.textContent),
      ),
    ).toEqual(['work', 'ideas']);
  });

  // Reaching up must not swallow anything the surrounding chrome owns. The title
  // input is the sharpest case: preventDefault on a hijacked mousedown would stop
  // it focusing at all.
  test('the surrounding chrome keeps its own clicks', async ({ page }) => {
    await setupEditor(page, 'first line');
    await setCursor(page, 5);

    await page.locator('.title-input').click();
    await expect(page.locator('.title-input')).toBeFocused();
    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });

    // The Add button sits INSIDE the note's surface, so only the target check
    // keeps this click. A hijacked mousedown still lets the click through to
    // `startAdding` — the body caret moving is what gives it away.
    await page.locator('.tag-add-btn').click();
    await expect(page.locator('.tag-input')).toBeFocused();
    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
  });

  // The title row sits above the note's surface, whose top edge is the tag bar.
  // Probed INSIDE the corridor so the side gate can't be what rejects it.
  test('within the corridor but above the tag bar clicks off', async ({ page }) => {
    await setupEditor(page, 'first line\nsecond line');
    await setCursor(page, 5);

    const point = await page.evaluate(() => {
      const view = (window as any).__cmGetView();
      const content = document.querySelector('.cm-content')!.getBoundingClientRect();
      const bar = document.querySelector('.note-tag-bar')!.getBoundingClientRect();
      const x = Math.round(content.left - view.defaultLineHeight); // half a reach out
      const y = Math.round(bar.top - 6);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        insideCorridor: x > content.left - view.defaultLineHeight * 2,
        aboveTheBar: y < bar.top,
        hitsBlankSpace: Boolean(hit?.classList.contains('note-body')),
      };
    });
    expect(point.insideCorridor).toBe(true);
    expect(point.aboveTheBar).toBe(true);
    expect(point.hitsBlankSpace).toBe(true);

    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(100);

    expect(await getSelection(page)).toEqual({ from: 5, to: 5 });
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-editor')))).toBe(
      false,
    );
  });

  // A modified click is a selection gesture; the platform owns it.
  test('shift-clicking in the reach zone does not collapse the selection', async ({ page }) => {
    await setupEditor(page, 'alpha bravo charlie delta');
    const probe = await probePoint(page, { side: 0.5 });
    await setCursor(page, 6);

    await page.keyboard.down('Shift');
    await page.mouse.click(probe.x, probe.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);

    const sel = await getSelection(page);
    expect(sel).not.toEqual({ from: 25, to: 25 }); // not collapsed to the end
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
