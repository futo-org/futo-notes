import { expect, test, type Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
}

async function setBody(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => {
    const view = (
      window as typeof window & {
        __cmGetView?: () => import('@codemirror/view').EditorView | null;
      }
    ).__cmGetView?.();
    if (!view) throw new Error('editor view is unavailable');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, body);
}

test.describe('Find in note', () => {
  test('opens, counts, steps, wraps, and closes from the keyboard', async ({ page }) => {
    await openNewNote(page);
    await setBody(page, 'cat dog CAT concatenate');

    await page.keyboard.press('Control+f');
    const query = page.locator('.cm-find-query');
    await expect(query).toBeFocused();
    const panelPlacement = await page.locator('.cm-find-panel').evaluate((panel) => {
      const editorPane = document.querySelector('.note-body');
      return {
        isBottomPanel: panel.parentElement?.classList.contains('cm-panels-bottom') ?? false,
        panelRect: panel.getBoundingClientRect().toJSON(),
        editorPaneRect: editorPane?.getBoundingClientRect().toJSON() ?? null,
      };
    });
    expect(panelPlacement.isBottomPanel).toBe(true);
    expect(panelPlacement.editorPaneRect).not.toBeNull();
    expect(panelPlacement.panelRect.x).toBe(panelPlacement.editorPaneRect?.x);
    expect(panelPlacement.panelRect.width).toBe(panelPlacement.editorPaneRect?.width);
    expect(panelPlacement.panelRect.bottom).toBe(panelPlacement.editorPaneRect?.bottom);
    await query.fill('cat');
    const count = page.locator('.cm-find-count');
    await expect(count).toHaveText(/^[1-3] of 3$/);
    await expect(page.locator('.cm-find-match')).toHaveCount(3);
    const initialIndex = Number((await count.textContent())?.split(' ')[0]);
    const after = (offset: number): string => `${((initialIndex - 1 + offset) % 3) + 1} of 3`;

    await query.press('Enter');
    await expect(count).toHaveText(after(1));
    await page.keyboard.press('Control+g');
    await expect(count).toHaveText(after(2));
    await page.keyboard.press('Control+g');
    await expect(count).toHaveText(after(3));
    await page.keyboard.press('Control+Shift+g');
    await expect(count).toHaveText(after(2));

    await query.press('Escape');
    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
    await expect(page.locator('.cm-find-match')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('Control+g');
    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
  });

  // Regression: CodeMirror's PanelGroup.syncClasses() copies the view's theme
  // classes onto our custom panel host, and CM6's base theme carries
  // `position: relative !important` — which beat the host's `position: sticky`
  // and let the whole find bar scroll off the bottom of the pane. The first
  // test's fixture is too short to scroll the pane, so it never saw this.
  test('stays docked to the pane bottom in a note tall enough to scroll', async ({ page }) => {
    await openNewNote(page);
    await setBody(
      page,
      Array.from({ length: 120 }, (_, index) => `paragraph ${index} cat`).join('\n\n'),
    );

    const paneScrolls = await page.locator('.note-body').evaluate((pane) => {
      return pane.scrollHeight > pane.clientHeight + 1;
    });
    expect(paneScrolls).toBe(true);

    await page.keyboard.press('Control+f');
    await expect(page.locator('.cm-find-query')).toBeFocused();

    const placement = async (): Promise<{ panelBottom: number; paneBottom: number }> =>
      page.locator('.cm-find-panel').evaluate((panel) => {
        const pane = document.querySelector('.note-body');
        if (!pane) throw new Error('editor pane is unavailable');
        return {
          panelBottom: panel.getBoundingClientRect().bottom,
          paneBottom: pane.getBoundingClientRect().bottom,
        };
      });

    const atTop = await placement();
    expect(atTop.panelBottom).toBe(atTop.paneBottom);

    await page.locator('.note-body').evaluate((pane) => {
      pane.scrollTop = Math.floor((pane.scrollHeight - pane.clientHeight) / 2);
    });
    await expect(page.locator('.cm-find-panel')).toBeVisible();

    const afterScroll = await placement();
    expect(afterScroll.panelBottom).toBe(afterScroll.paneBottom);
  });

  test('reveals a source-markdown match while the query owns focus', async ({ page }) => {
    await openNewNote(page);
    await setBody(page, '[label](hidden-target)');
    await page.locator('.title-input').click();
    await expect(page.locator('.cm-content')).not.toContainText('hidden-target');

    await page.keyboard.press('Control+f');
    await page.locator('.cm-find-query').fill('hidden');
    await expect(page.locator('.cm-find-count')).toHaveText('1 of 1');

    await expect(page.locator('.cm-content')).toContainText('hidden-target');
    await expect(page.locator('.cm-find-query')).toBeFocused();
    await expect(page.locator('.cm-find-match-current')).toHaveText('hidden');
  });

  // Stepping moves a real selection, so the formatting bubble used to pop over
  // the text on every step, follow the stepping, and outlive the bar (Escape
  // leaves the selection on the match by spec).
  test('keeps the selection toolbar down while find owns the selection', async ({ page }) => {
    await openNewNote(page);
    await setBody(page, 'cat one\ncat two\ncat three');
    const bubble = page.locator('.sf-selection-toolbar');

    await page.keyboard.press('Control+f');
    await page.locator('.cm-find-query').fill('cat');
    await expect(page.locator('.cm-find-count')).toHaveText(/of 3$/);
    await expect(bubble).toHaveCount(0);

    await page.locator('.cm-find-query').press('Enter');
    await expect(page.locator('.cm-find-match-current')).toHaveCount(1);
    await expect(bubble).toHaveCount(0);

    // Escape leaves the selection on the match — the bubble must not appear for
    // a selection find placed.
    await page.locator('.cm-find-query').press('Escape');
    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
    await expect(bubble).toHaveCount(0);

    // A selection the user makes afterwards is ordinary again.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(bubble).toHaveCount(1);
  });

  test('does nothing on the Home tab', async ({ page }) => {
    await page.goto('/#/');
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('Control+f');

    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
  });
});

// The desktop find bar is `position: sticky; bottom: 0` INSIDE the scrolling
// pane, so it paints over the bottom strip of the scrollport instead of
// shrinking it. Nothing asserted that the match the user stepped to actually
// landed above the bar: a QA sweep of 10 matches in an 800x600 window found 7
// revealed under it (9-69px) and one wholly off screen.
// → docs/spec/editor.md "Find in note"
test.describe('Find in note — current match clearance', () => {
  test.use({ viewport: { width: 800, height: 600 } });

  /**
   * A paragraph long enough to wrap several times, like the notes people
   * actually search: CodeMirror estimates the height of lines it has not
   * measured, so a pane full of wrapped paragraphs relayouts once the scroll
   * brings them into view.
   */
  const filler = (index: number): string =>
    `Paragraph ${String(index).padStart(3, '0')} — ${'notes cursor paragraph document '.repeat(7)}and one more clause to finish the line.`;

  interface MatchGeometry {
    matchTop: number;
    matchBottom: number;
    barTop: number;
    paneTop: number;
  }

  /**
   * Resolve once the current match's rect has held still for three frames:
   * the reveal of hidden markdown relayouts a frame after the scroll, and a
   * fixed wait would either flake or read the pre-reflow position.
   */
  async function currentMatchGeometry(page: Page): Promise<MatchGeometry> {
    return page.evaluate(
      () =>
        new Promise<MatchGeometry>((resolve, reject) => {
          let previous = '';
          let stable = 0;
          let frames = 0;
          const tick = (): void => {
            const match = document.querySelector('.cm-find-match-current');
            const bar = document.querySelector('.editor-find-panel-host');
            const pane = document.querySelector('.note-body');
            if (!bar || !pane) {
              reject(new Error('find bar or editor pane is unavailable'));
              return;
            }
            const rect = match?.getBoundingClientRect();
            const key = rect ? `${rect.top}:${rect.bottom}` : 'none';
            stable = key === previous ? stable + 1 : 0;
            previous = key;
            if (stable >= 3) {
              if (!rect) {
                reject(new Error('no current match is rendered'));
                return;
              }
              resolve({
                matchTop: rect.top,
                matchBottom: rect.bottom,
                barTop: bar.getBoundingClientRect().top,
                paneTop: pane.getBoundingClientRect().top,
              });
              return;
            }
            if (++frames > 180) {
              reject(new Error('current match never settled'));
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  }

  function expectClear(geometry: MatchGeometry, label: string): void {
    const covered = Math.round(geometry.matchBottom - geometry.barTop);
    expect(
      geometry.matchBottom,
      `${label}: revealed ${covered}px under the find bar`,
    ).toBeLessThanOrEqual(geometry.barTop + 0.5);
    expect(geometry.matchTop, `${label}: revealed above the pane top`).toBeGreaterThanOrEqual(
      geometry.paneTop - 0.5,
    );
  }

  test('reveals every stepped match above the docked bar', async ({ page }) => {
    await openNewNote(page);
    const lines: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      for (let pad = 0; pad < 6; pad += 1) lines.push(filler(index * 10 + pad));
      lines.push(`marker ${index} example line`);
    }
    await setBody(page, lines.join('\n\n'));

    await page.keyboard.press('Control+f');
    await page.locator('.cm-find-query').fill('example');
    const count = page.locator('.cm-find-count');
    await expect(count).toHaveText(/of 10$/);

    // One full cycle plus the wrap back to the first match, which lands its
    // own scroll: the sweep has to see where that one settles too.
    const covered: string[] = [];
    for (let step = 0; step <= 10; step += 1) {
      const label = (await count.textContent()) ?? '';
      const geometry = await currentMatchGeometry(page);
      if (
        geometry.matchBottom > geometry.barTop + 0.5 ||
        geometry.matchTop < geometry.paneTop - 0.5
      )
        covered.push(
          `${label}: match ${Math.round(geometry.matchTop)}..${Math.round(geometry.matchBottom)}, bar top ${Math.round(geometry.barTop)}`,
        );
      await page.locator('.cm-find-query').press('Enter');
      await expect(count).not.toHaveText(label);
    }

    expect(covered, `matches revealed under the find bar:\n${covered.join('\n')}`).toEqual([]);
  });

  // The reveal of hidden markdown lands a relayout AFTER the scroll that
  // revealed the match: CodeMirror scrolls to where the URL sits while the
  // live preview still hides it, then the line reveals, reflows, and drops the
  // match back under the bar (QA measured 25px with the bar's height already
  // subtracted). Reaching the match by STEPPING is what orders it that way.
  test('keeps a match inside link markup clear after its reveal reflows the line', async ({
    page,
  }) => {
    await openNewNote(page);
    const lines = ['# Find in note', '', 'This example note demonstrates find end to end.', ''];
    for (let index = 0; index < 3; index += 1) lines.push(filler(index), '');
    lines.push(
      'Stepping past the last example wraps back around to the first one.',
      '',
      '## Hidden markdown source',
      '',
      'A match can also live inside markdown that live preview normally hides —',
      'for instance in the URL of [the project site](https://example.com/find),',
      'where the word is part of the link target, not its label.',
      '',
    );
    for (let index = 3; index < 33; index += 1) lines.push(filler(index), '');
    await setBody(page, lines.join('\n'));

    await page.keyboard.press('Control+f');
    await page.locator('.cm-find-query').fill('example');
    const count = page.locator('.cm-find-count');
    await expect(count).toHaveText('1 of 3');

    // Step onto the URL match from the match just above it: a short scroll,
    // so the line is already on screen with the URL still hidden when
    // CodeMirror reads the coordinates it scrolls to.
    await page.locator('.cm-find-query').press('Enter');
    await expect(count).toHaveText('2 of 3');
    await page.locator('.cm-find-query').press('Enter');
    await expect(count).toHaveText('3 of 3');
    await expect(page.locator('.cm-content')).toContainText('https://example.com/find');

    expectClear(await currentMatchGeometry(page), 'match inside link markup');
  });
});
