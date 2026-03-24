import { test, expect, Page } from '@playwright/test';
import { loadSpecCases, getCasesDir } from '../markdown-spec/loader.js';
import type { DecorationExpectation, WidgetExpectation } from '../markdown-spec/schema.js';

/**
 * Playwright runner for YAML spec cases.
 * Filter by complexity: SPEC_MAX_COMPLEXITY=50 pnpm run test -- markdown-spec
 */

const maxComplexity = process.env.SPEC_MAX_COMPLEXITY
  ? parseInt(process.env.SPEC_MAX_COMPLEXITY)
  : undefined;

const clientCases = loadSpecCases(getCasesDir(), maxComplexity).filter(c =>
  c.expect.decorations ||
  c.expect.visible_text !== undefined ||
  c.expect.visible_text_contains ||
  c.expect.visible_text_excludes ||
  c.expect.widgets
);

async function setupEditor(page: Page, content: string): Promise<void> {
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
      selection: { anchor: 0 },
    });
  }, content);

  await page.waitForTimeout(200);
}

async function blurEditor(page: Page): Promise<void> {
  // Move cursor past all content so it's not inside any block element.
  // tableRenderingField checks state.selection (not focus) to decide
  // whether to show the table widget or raw markdown.
  await page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    if (!view) return;
    const len = view.state.doc.length;
    if (!view.state.doc.sliceString(len - 1, len).includes('\n')) {
      view.dispatch({ changes: { from: len, insert: '\n' }, selection: { anchor: len + 1 } });
    } else {
      view.dispatch({ selection: { anchor: len } });
    }
  });
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(300);
}

async function setCursor(page: Page, line: number, ch: number): Promise<void> {
  // Blur first so focusChanged triggers a full decoration rebuild
  // (the plugin doesn't rebuild on within-line cursor moves alone).
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(100);

  await page.evaluate(({ line, ch }) => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const doc = view.state.doc;
    const lineObj = doc.line(Math.min(line + 1, doc.lines));
    const pos = Math.min(lineObj.from + ch, lineObj.to);
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, { line, ch });
  await page.waitForTimeout(300);
}

async function getVisibleText(page: Page): Promise<string> {
  return page.locator('.cm-content').evaluate((el) => (el as HTMLElement).innerText);
}

async function checkDecorations(page: Page, expectations: DecorationExpectation[]): Promise<void> {
  for (const exp of expectations) {
    const selector = `.${exp.class.replace(/\s+/g, '.')}`;
    const elements = page.locator(selector);

    if (exp.count !== undefined) {
      await expect(elements).toHaveCount(exp.count);
      if (exp.count === 0) continue;
    }

    if (exp.text !== undefined) {
      const texts = await elements.allInnerTexts();
      expect(texts.some(t => t.trim() === exp.text)).toBe(true);
    }

    if (exp.attrs) {
      for (const [key, value] of Object.entries(exp.attrs)) {
        await expect(elements.first()).toHaveAttribute(key, value);
      }
    }
  }
}

async function checkWidgets(page: Page, expectations: WidgetExpectation[]): Promise<void> {
  for (const exp of expectations) {
    const elements = page.locator(`.${exp.class}`);
    if (exp.count !== undefined) {
      await expect(elements).toHaveCount(exp.count);
    } else {
      await expect(elements.first()).toBeVisible();
    }
  }
}

test.describe('Markdown Spec', () => {
  for (const specCase of clientCases) {
    test(`[${specCase.complexity}] ${specCase.name}`, async ({ page }) => {
      await setupEditor(page, specCase.markdown);

      if (specCase.cursor === null) {
        await blurEditor(page);
      } else {
        await setCursor(page, specCase.cursor.line, specCase.cursor.ch);
      }

      if (specCase.expect.decorations) {
        await checkDecorations(page, specCase.expect.decorations);
      }
      if (specCase.expect.widgets) {
        await checkWidgets(page, specCase.expect.widgets);
      }

      const needsText = specCase.expect.visible_text !== undefined ||
        specCase.expect.visible_text_contains ||
        specCase.expect.visible_text_excludes;

      if (needsText) {
        const visibleText = await getVisibleText(page);

        if (specCase.expect.visible_text !== undefined) {
          const normalized = visibleText.split('\n').map(l => l.trimEnd()).join('\n').trim();
          expect(normalized).toBe(specCase.expect.visible_text.trim());
        }
        if (specCase.expect.visible_text_contains) {
          expect(visibleText).toContain(specCase.expect.visible_text_contains);
        }
        if (specCase.expect.visible_text_excludes) {
          expect(visibleText).not.toContain(specCase.expect.visible_text_excludes);
        }
      }
    });
  }
});
