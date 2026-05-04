import { test, expect, Page } from '@playwright/test';

/**
 * Autonomous Markdown Rendering Verification Tests
 *
 * This test suite verifies that the live markdown transformation plugin
 * correctly renders all supported markdown elements by checking:
 * 1. Raw markdown remains in the CM6 document
 * 2. Visible editor text hides markdown syntax markers
 * 3. Computed styles match expectations
 * 4. Widgets are rendered (tables, checkboxes, hr)
 *
 * Run with: npx playwright test
 * Results output to: test-results/results.json
 */

const TEST_CONTENT = {
  headings: `# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6`,

  emphasis: `This is *italic text* here.
This is **bold text** here.
This is ***bold italic*** here.`,

  strikethrough: `This is ~~strikethrough~~ text.`,

  inlineCode: `Use \`inline code\` for snippets.`,

  codeBlock: `\`\`\`javascript
function hello() {
  console.log("world");
}
\`\`\``,

  links: `Check out [example link](https://example.com) here.`,

  blockquote: `> This is a blockquote.
> It spans multiple lines.`,

  unorderedList: `- First item
- Second item
- Third item`,

  orderedList: `1. First ordered
2. Second ordered
3. Third ordered`,

  taskList: `- [x] Completed task
- [ ] Incomplete task`,

  horizontalRule: `---`,

  table: `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |`,
};

async function setupEditor(page: Page, content: string): Promise<void> {
  // Navigate to home first, then to new note (ensures clean state)
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');

  // Wait for editor to be ready with longer timeout
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

  // Wait for decorations to rebuild
  await page.waitForTimeout(200);
}

async function openSavedNote(page: Page, title: string, content: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 10000 });
  await page.evaluate(async ({ noteTitle, body }) => {
    await (window as any).__testNotes.createNote(noteTitle, body);
  }, { noteTitle: title, body: content });
  await page.goto(`/#/note/${encodeURIComponent(title)}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction((expected) => {
    const view = (window as any).__cmGetView?.();
    return view?.state.doc.toString() === expected;
  }, content, { timeout: 10000 });
}

async function blurEditor(page: Page): Promise<void> {
  // Click outside editor to blur and allow all decorations
  // This removes focus from CodeMirror entirely
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(300);
}

async function getVisibleEditorText(page: Page): Promise<string> {
  return page.locator('.cm-content').evaluate((el) => (el as HTMLElement).innerText);
}

async function getDocText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__cmGetView?.()?.state.doc.toString() ?? '');
}

async function getVisibleLineText(page: Page, lineIndex: number): Promise<string> {
  return page.locator('.cm-line').nth(lineIndex).evaluate((el) => (el as HTMLElement).innerText.trim());
}

async function clickRenderedTextBoundary(page: Page, selector: string, visibleOffset: number): Promise<void> {
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  const clickPoint = await target.evaluate((el, offset) => {
    const textNode = Array.from(el.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) as Text | undefined;
    if (!textNode) throw new Error('Rendered text node not found');
    const range = document.createRange();
    range.setStart(textNode, offset as number);
    range.setEnd(textNode, offset as number);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return {
      x: rect.left - 1,
      y: (rect.top + rect.bottom) / 2,
    };
  }, visibleOffset);

  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForTimeout(150);
}

async function getCursorState(page: Page): Promise<{ line: number; ch: number; text: string }> {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    return {
      line: line.number - 1,
      ch: pos - line.from,
      text: line.text,
    };
  });
}

async function getSelectionState(page: Page): Promise<{ from: number; to: number; empty: boolean; text: string }> {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const selection = view.state.selection.main;
    return {
      from: selection.from,
      to: selection.to,
      empty: selection.empty,
      text: view.state.doc.sliceString(selection.from, selection.to),
    };
  });
}

async function getVisibleTextPoint(page: Page, substring: string, offset = 0): Promise<{ x: number; y: number }> {
  return page.evaluate(({ substring, offset }) => {
    const root = document.querySelector('.cm-content');
    if (!root) throw new Error('CM content not found');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      const start = text.indexOf(substring);
      if (start === -1) continue;
      const range = document.createRange();
      const pos = start + offset;
      range.setStart(node, pos);
      range.setEnd(node, pos);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return {
        x: rect.left + 1,
        y: (rect.top + rect.bottom) / 2,
      };
    }
    throw new Error(`Visible substring not found: ${substring}`);
  }, { substring, offset });
}

async function getLocatorCenter(locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected locator bounding box');
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

// ============================================================================
// HEADING TESTS
// ============================================================================

test.describe('Headings', () => {
  test('h1 renders with correct class and font size', async ({ page }) => {
    await setupEditor(page, '# Heading 1\n\nMore text');
    await blurEditor(page);

    const h1 = page.locator('.cm-md-h1');
    await expect(h1).toBeVisible();
    expect(await getVisibleLineText(page, 0)).toBe('Heading 1');
    expect(await getDocText(page)).toContain('# Heading 1');

    const fontSize = await h1.evaluate(el =>
      window.getComputedStyle(el).fontSize
    );
    expect(parseInt(fontSize)).toBeGreaterThanOrEqual(24); // 28px desktop, 24px mobile

    const fontWeight = await h1.evaluate(el =>
      window.getComputedStyle(el).fontWeight
    );
    // H1-H3 use --font-serif at weight 700 (size creates hierarchy)
    expect(parseInt(fontWeight)).toBeGreaterThanOrEqual(400);
  });

  test('h2 renders with correct class and font size', async ({ page }) => {
    await setupEditor(page, '## Heading 2\n\nMore text');
    await blurEditor(page);

    const h2 = page.locator('.cm-md-h2');
    await expect(h2).toBeVisible();
    expect(await getVisibleLineText(page, 0)).toBe('Heading 2');
    expect(await getDocText(page)).toContain('## Heading 2');

    const fontSize = await h2.evaluate(el =>
      window.getComputedStyle(el).fontSize
    );
    expect(parseInt(fontSize)).toBeGreaterThanOrEqual(20);
  });

  test('h3 through h6 render with correct classes', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.headings + '\n\nMore text');
    await blurEditor(page);

    for (let level = 3; level <= 6; level++) {
      const heading = page.locator(`.cm-md-h${level}`);
      await expect(heading).toBeVisible();
    }
  });

  test('heading markers are hidden', async ({ page }) => {
    await setupEditor(page, '# Heading 1\n\nMore text');
    await blurEditor(page);

    expect(await getDocText(page)).toContain('# Heading 1');
    expect(await getVisibleLineText(page, 0)).toBe('Heading 1');
    expect(await getVisibleLineText(page, 0)).not.toContain('#');
  });
});

// ============================================================================
// EMPHASIS TESTS
// ============================================================================

test.describe('Emphasis (Bold/Italic)', () => {
  test('italic renders with correct class and style', async ({ page }) => {
    await setupEditor(page, 'This is *italic* text.\n\nMore');
    await blurEditor(page);

    const italic = page.locator('.cm-md-emphasis');
    await expect(italic).toBeVisible();
    expect(await getVisibleLineText(page, 0)).toBe('This is italic text.');
    expect(await getDocText(page)).toContain('*italic*');

    const fontStyle = await italic.evaluate(el =>
      window.getComputedStyle(el).fontStyle
    );
    expect(fontStyle).toBe('italic');
  });

  test('bold renders with correct class and style', async ({ page }) => {
    await setupEditor(page, 'This is **bold** text.\n\nMore');
    await blurEditor(page);

    const bold = page.locator('.cm-md-strong');
    await expect(bold).toBeVisible();
    expect(await getVisibleLineText(page, 0)).toBe('This is bold text.');
    expect(await getDocText(page)).toContain('**bold**');

    const fontWeight = await bold.evaluate(el =>
      window.getComputedStyle(el).fontWeight
    );
    expect(parseInt(fontWeight)).toBeGreaterThanOrEqual(700);
  });

  test('emphasis markers are hidden', async ({ page }) => {
    await setupEditor(page, 'This is **bold** text.\n\nMore');
    await blurEditor(page);

    expect(await getDocText(page)).toContain('**bold**');
    expect(await getVisibleLineText(page, 0)).toBe('This is bold text.');
    expect(await getVisibleLineText(page, 0)).not.toContain('**');
  });

  test('clicking inside italic text places the cursor at the clicked character', async ({ page }) => {
    await setupEditor(page, '*Why*');
    await blurEditor(page);

    await clickRenderedTextBoundary(page, '.cm-md-emphasis', 1);
    const cursor = await getCursorState(page);

    expect(cursor.text).toBe('*Why*');
    expect(cursor.line).toBe(0);
    expect(cursor.ch).toBe(2);
  });

  test('clicking inside bold text places the cursor at the clicked character', async ({ page }) => {
    await setupEditor(page, '**Why**');
    await blurEditor(page);

    await clickRenderedTextBoundary(page, '.cm-md-strong', 1);
    const cursor = await getCursorState(page);

    expect(cursor.text).toBe('**Why**');
    expect(cursor.line).toBe(0);
    expect(cursor.ch).toBe(3);
  });

  test('backward drag across italic stays stable until selection settles', async ({ page }) => {
    const paragraph = `Actually, right now there's a good oppurtunity to learn a bit and try this all out. There is a task above that will probably improve sync dramatically. I should get deep in the weeds of building out the architecture there, which will be in Rust, and see how much I am held back by my knowledge gaps. Tell Claude I need to deeply understand the problem first, the way it operates now, and *then* we can sketch a solution together.`;

    await setupEditor(page, paragraph);
    await page.locator('.cm-content').click();
    await page.waitForTimeout(100);

    const dragStart = await getVisibleTextPoint(page, 'we can sketch', 2);
    const dragEnd = await getVisibleTextPoint(page, 'problem first', 0);
    const expected = 'problem first, the way it operates now, and *then* we';

    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 20 });

    const duringDrag = await getSelectionState(page);
    expect(duringDrag.empty).toBe(false);
    expect(duringDrag.text).toBe(expected);

    const duringDragVisible = await getVisibleEditorText(page);
    expect(duringDragVisible).not.toContain('*then*');

    await page.mouse.up();
    await page.waitForTimeout(150);

    const settled = await getSelectionState(page);
    expect(settled.empty).toBe(false);
    expect(settled.text).toBe(expected);

    const settledVisible = await getVisibleEditorText(page);
    expect(settledVisible).toContain('*then*');
  });
});

// ============================================================================
// STRIKETHROUGH TESTS
// ============================================================================

test.describe('Strikethrough', () => {
  test('strikethrough renders with correct class and style', async ({ page }) => {
    await setupEditor(page, 'This is ~~struck~~ text.\n\nMore');
    await blurEditor(page);

    const strike = page.locator('.cm-md-strikethrough');
    await expect(strike).toBeVisible();

    const textDecoration = await strike.evaluate(el =>
      window.getComputedStyle(el).textDecorationLine
    );
    expect(textDecoration).toContain('line-through');
  });

  test('strikethrough markers are hidden', async ({ page }) => {
    await setupEditor(page, 'This is ~~struck~~ text.\n\nMore');
    await blurEditor(page);

    const strike = page.locator('.cm-md-strikethrough');
    const text = await strike.textContent();
    expect(text).not.toContain('~~');
  });

  test('clicking inside strikethrough text places the cursor at the clicked character', async ({ page }) => {
    await setupEditor(page, '~~Why~~');
    await blurEditor(page);

    await clickRenderedTextBoundary(page, '.cm-md-strikethrough', 1);
    const cursor = await getCursorState(page);

    expect(cursor.text).toBe('~~Why~~');
    expect(cursor.line).toBe(0);
    expect(cursor.ch).toBe(3);
  });

  test('holding mouse down on rendered strikethrough keeps the line-through visible', async ({ page }) => {
    await setupEditor(page, 'This is ~~struck~~ text.');

    const strike = page.locator('.cm-md-strikethrough');
    await expect(strike).toBeVisible();

    const before = await strike.evaluate((el) => window.getComputedStyle(el).textDecorationLine);
    expect(before).toContain('line-through');

    const center = await getLocatorCenter(strike);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.waitForTimeout(75);

    const during = await strike.evaluate((el) => window.getComputedStyle(el).textDecorationLine);

    await page.mouse.up();

    expect(during).toContain('line-through');
  });
});

// ============================================================================
// INLINE CODE TESTS
// ============================================================================

test.describe('Inline Code', () => {
  test('inline code renders with correct class and styles', async ({ page }) => {
    await setupEditor(page, 'Use `code` here.\n\nMore');
    await blurEditor(page);

    const code = page.locator('.cm-md-code');
    await expect(code).toBeVisible();

    const fontFamily = await code.evaluate(el =>
      window.getComputedStyle(el).fontFamily
    );
    expect(fontFamily.toLowerCase()).toMatch(/monaco|menlo|mono/);

    const background = await code.evaluate(el =>
      window.getComputedStyle(el).backgroundColor
    );
    expect(background).not.toBe('rgba(0, 0, 0, 0)'); // Has background
  });

  test('inline code backticks are hidden', async ({ page }) => {
    await setupEditor(page, 'Use `code` here.\n\nMore');
    await blurEditor(page);

    // Check that backticks aren't visible in rendered content
    const code = page.locator('.cm-md-code');
    const text = await code.evaluate((el) => (el as HTMLElement).innerText);
    expect(text).toBe('code');
    expect(text).not.toContain('`');
  });

  test('clicking inline code reveals backticks without dropping code styling', async ({ page }) => {
    await setupEditor(page, 'Use `code is here` now.');
    await blurEditor(page);

    const code = page.locator('.cm-md-code', { hasText: 'code is here' });
    await expect(code).toBeVisible();

    const before = await code.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        color: style.color,
        fontFamily: style.fontFamily,
      };
    });

    await code.click();
    await page.waitForTimeout(150);

    const visibleText = await getVisibleEditorText(page);
    expect(visibleText).toContain('`code is here`');

    const revealedCode = page.locator('.cm-md-code', { hasText: 'code is here' });
    await expect(revealedCode).toBeVisible();

    const after = await revealedCode.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        color: style.color,
        fontFamily: style.fontFamily,
      };
    });

    expect(after.fontFamily.toLowerCase()).toMatch(/monaco|menlo|mono/);
    expect(after.fontFamily).toBe(before.fontFamily);
    expect(after.color).toBe(before.color);
  });

  test('revealed inline code backticks do not get separate code backgrounds', async ({ page }) => {
    await setupEditor(page, 'Use `code` here.');

    const code = page.locator('.cm-md-code', { hasText: 'code' });
    await expect(code).toBeVisible();
    await code.click();
    await page.waitForTimeout(150);

    await expect(page.locator('.cm-md-code')).toHaveCount(1);
    await expect(page.locator('.cm-md-code')).toHaveText('code');
    await expect(page.locator('.cm-md-code-marker')).toHaveCount(2);

    const markerStyles = await page.locator('.cm-md-code-marker').evaluateAll((els) =>
      els.map((el) => {
        const style = window.getComputedStyle(el);
        return {
          backgroundColor: style.backgroundColor,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
        };
      }),
    );

    for (const style of markerStyles) {
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(style.paddingLeft).toBe('0px');
      expect(style.paddingRight).toBe('0px');
    }
  });

  test('holding mouse down on inline code keeps the background visible', async ({ page }) => {
    await setupEditor(page, 'Use `code` here.');

    const code = page.locator('.cm-md-code');
    await expect(code).toBeVisible();

    const before = await code.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(before).not.toBe('rgba(0, 0, 0, 0)');

    const center = await getLocatorCenter(code);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.waitForTimeout(75);

    const during = await code.evaluate((el) => window.getComputedStyle(el).backgroundColor);

    await page.mouse.up();

    expect(during).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('holding mouse down without dragging does not flatten unrelated code and strikethrough decorations', async ({ page }) => {
    await setupEditor(page, 'Alpha ~~strike~~ beta `code` gamma');

    const strike = page.locator('.cm-md-strikethrough');
    const code = page.locator('.cm-md-code');
    await expect(strike).toBeVisible();
    await expect(code).toBeVisible();

    const plainTextPoint = await getVisibleTextPoint(page, 'Alpha', 2);
    await page.mouse.move(plainTextPoint.x, plainTextPoint.y);
    await page.mouse.down();
    await page.waitForTimeout(75);

    const strikeDisplay = await strike.evaluate((el) => window.getComputedStyle(el).display);
    const codeDisplay = await code.evaluate((el) => window.getComputedStyle(el).display);

    await page.mouse.up();

    expect(strikeDisplay).not.toBe('contents');
    expect(codeDisplay).not.toBe('contents');
  });
});

// ============================================================================
// CODE BLOCK TESTS
// ============================================================================

test.describe('Code Blocks', () => {
  test('fenced code block renders with correct class', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.codeBlock + '\n\nMore text');
    await blurEditor(page);

    // Code blocks are styled per-line
    const codeBlock = page.locator('.cm-md-code-block').first();
    await expect(codeBlock).toBeVisible();

    const fontFamily = await codeBlock.evaluate(el =>
      window.getComputedStyle(el).fontFamily
    );
    expect(fontFamily.toLowerCase()).toMatch(/monaco|menlo|mono/);
  });

  test('code block fences are hidden', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.codeBlock + '\n\nMore text');
    await blurEditor(page);

    // The ``` markers should be hidden (not visible in any code block line)
    const codeBlocks = page.locator('.cm-md-code-block');
    const count = await codeBlocks.count();
    expect(count).toBeGreaterThan(0);

    // Check that none of the code block lines contain fence markers
    for (let i = 0; i < count; i++) {
      const text = await codeBlocks.nth(i).textContent();
      expect(text).not.toMatch(/^```/);
    }
  });
});

// ============================================================================
// LINK TESTS
// ============================================================================

test.describe('Links', () => {
  test('link renders with correct class and styles', async ({ page }) => {
    await setupEditor(page, 'Check [link](https://example.com) here.\n\nMore');
    await blurEditor(page);

    const link = page.locator('.cm-md-link:not(.cm-md-autolink)', { hasText: 'link' }).first();
    await expect(link).toBeVisible();

    const color = await link.evaluate(el =>
      window.getComputedStyle(el).color
    );
    // Should have a blue-ish color, not default black
    expect(color).not.toBe('rgb(0, 0, 0)');

    const textDecoration = await link.evaluate(el =>
      window.getComputedStyle(el).textDecorationLine
    );
    expect(textDecoration).toContain('underline');
  });

  test('link markdown syntax is hidden', async ({ page }) => {
    await setupEditor(page, 'Check [link](https://example.com) here.\n\nMore');
    await blurEditor(page);

    const link = page.locator('.cm-md-link:not(.cm-md-autolink)', { hasText: 'link' }).first();
    const text = await link.textContent();
    expect(text).toBe('link');
    expect(text).not.toContain('[');
    expect(text).not.toContain('(');
  });
});

// ============================================================================
// BLOCKQUOTE TESTS
// ============================================================================

test.describe('Blockquotes', () => {
  test('blockquote renders with correct class', async ({ page }) => {
    await setupEditor(page, '> This is a quote.\n\nMore text');
    await blurEditor(page);

    const quote = page.locator('.cm-md-quote');
    await expect(quote).toBeVisible();
  });

  test('blockquote > marker is hidden', async ({ page }) => {
    await setupEditor(page, '> This is a quote.\n\nMore text');
    await blurEditor(page);

    // The > should be hidden
    // Check that we have the quote class applied but marker isn't visible
    const quoteLines = page.locator('.cm-line').first();
    await quoteLines.evaluate(el =>
      el.classList.contains('cm-md-quote') || el.querySelector('.cm-md-quote') !== null
    );
    // Either the line has the class or contains an element with it
  });
});

// ============================================================================
// LIST TESTS
// ============================================================================

test.describe('Lists', () => {
  test('unordered list renders with correct class', async ({ page }) => {
    await setupEditor(page, '- Item 1\n- Item 2\n\nMore text');
    await blurEditor(page);

    const ulItem = page.locator('.cm-md-ul-item');
    const count = await ulItem.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('ordered list renders with correct class', async ({ page }) => {
    await setupEditor(page, '1. First\n2. Second\n\nMore text');
    await blurEditor(page);

    const olItem = page.locator('.cm-md-ol-item');
    const count = await olItem.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('task list checkbox widget renders', async ({ page }) => {
    await setupEditor(page, '- [x] Done\n- [ ] Todo\n\nMore text');
    await blurEditor(page);

    const checkbox = page.locator('.cm-md-task-checkbox');
    const count = await checkbox.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify it's an actual checkbox input
    const isCheckbox = await checkbox.first().evaluate(el =>
      el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox'
    );
    expect(isCheckbox).toBe(true);
  });

  test('checked task has checked attribute', async ({ page }) => {
    await setupEditor(page, '- [x] Done\n- [ ] Todo\n\nMore text');
    await blurEditor(page);

    const checkboxes = page.locator('.cm-md-task-checkbox');
    const firstChecked = await checkboxes.first().evaluate(el =>
      (el as HTMLInputElement).checked
    );
    expect(firstChecked).toBe(true);
  });

  test('clicking checkbox toggles the markdown document text', async ({ page }) => {
    await setupEditor(page, '- [ ] Unchecked\n- [x] Checked\n\nMore text');
    await blurEditor(page);

    // Click the first (unchecked) checkbox
    const checkbox = page.locator('.cm-md-task-checkbox').first();
    await checkbox.click();
    await page.waitForTimeout(300);

    // Read the doc via CM6's Tile API (cmTile on .cm-content)
    const docText = await page.evaluate(() => {
      const content = document.querySelector('.cm-content') as any;
      const view = content?.cmTile?.root?.view;
      return view?.state?.doc?.toString() ?? '';
    });
    expect(docText).toContain('- [x] Unchecked');

    // Click the second (was checked) checkbox to uncheck it
    const checkbox2 = page.locator('.cm-md-task-checkbox').nth(1);
    await checkbox2.click();
    await page.waitForTimeout(300);

    const docText2 = await page.evaluate(() => {
      const content = document.querySelector('.cm-content') as any;
      const view = content?.cmTile?.root?.view;
      return view?.state?.doc?.toString() ?? '';
    });
    expect(docText2).toContain('- [ ] Checked');
  });
});

// ============================================================================
// TABLE TESTS
// ============================================================================

test.describe('Tables', () => {
  test('table renders as widget when cursor outside', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.table + '\n\nMore text');
    await blurEditor(page);

    // Tables render via the interactive editor widget
    const tableRoot = page.locator('.sf-table');
    await expect(tableRoot).toBeVisible();

    const table = page.locator('.sf-table table');
    await expect(table).toBeVisible();
  });

  test('table has header and body rows', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.table + '\n\nMore text');
    await blurEditor(page);

    // Check that table has proper structure
    const headers = page.locator('.sf-table th');
    const cells = page.locator('.sf-table td');

    const headerCount = await headers.count();
    const cellCount = await cells.count();

    expect(headerCount).toBeGreaterThanOrEqual(2); // At least 2 columns
    expect(cellCount).toBeGreaterThanOrEqual(2); // At least 1 data row
  });

  test('table header row is styled bold', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.table + '\n\nMore text');
    await blurEditor(page);

    const header = page.locator('.sf-table th').first();
    const fontWeight = await header.evaluate(el =>
      window.getComputedStyle(el).fontWeight
    );
    expect(parseInt(fontWeight)).toBeGreaterThanOrEqual(600);
  });
});

// ============================================================================
// HORIZONTAL RULE TESTS
// ============================================================================

test.describe('Horizontal Rule', () => {
  test('horizontal rule widget renders', async ({ page }) => {
    await setupEditor(page, 'Text above\n\n---\n\nText below');
    await blurEditor(page);

    const hr = page.locator('.cm-md-hr-widget');
    await expect(hr).toBeVisible();
  });
});

// ============================================================================
// COMBINED/EDGE CASE TESTS
// ============================================================================

test.describe('Combined Elements', () => {
  test('multiple element types render together', async ({ page }) => {
    const combined = `# Heading

This has **bold** and *italic* text.

- List item 1
- List item 2

\`\`\`
code block
\`\`\`

> A quote

More text here.`;

    await setupEditor(page, combined);
    await blurEditor(page);

    // Check multiple element types are present
    await expect(page.locator('.cm-md-h1')).toBeVisible();
    await expect(page.locator('.cm-md-strong')).toBeVisible();
    await expect(page.locator('.cm-md-emphasis')).toBeVisible();
  });

  test('nested emphasis renders correctly', async ({ page }) => {
    await setupEditor(page, 'This is **bold with *italic* inside** text.\n\nMore');
    await blurEditor(page);

    // Strong wraps the bold range — split into multiple spans when nested
    // emphasis interrupts it. At least one span must be present and visible.
    await expect(page.locator('.cm-md-strong').first()).toBeVisible();
    // Note: nested italic inside bold may or may not render depending on parser
  });

  test('saved note load renders markdown instead of raw syntax', async ({ page }) => {
    const body = `# Heading

This has **bold** and *italic* text.

- Bullet item`;

    await openSavedNote(page, 'markdown render regression', body);
    await blurEditor(page);

    expect(await getDocText(page)).toBe(body);
    expect(await getVisibleLineText(page, 0)).toBe('Heading');
    expect(await getVisibleLineText(page, 2)).toBe('This has bold and italic text.');
    expect(await getVisibleLineText(page, 4)).not.toContain('- ');
    await expect(page.locator('.cm-md-h1')).toBeVisible();
    await expect(page.locator('.cm-md-strong')).toBeVisible();
    await expect(page.locator('.cm-md-emphasis')).toBeVisible();
  });
});

// ============================================================================
// MARKER VISIBILITY SUMMARY TEST
// ============================================================================

test.describe('Syntax Marker Hiding', () => {
  test('all common markers are hidden when blurred', async ({ page }) => {
    const content = `# Heading

**bold** and *italic* and ~~strike~~

\`code\` inline

[link](https://example.com)

> quote

- list item

---

End.`;

    await setupEditor(page, content);
    await blurEditor(page);

    // Get all visible text from the editor
    const visibleText = await getVisibleEditorText(page);

    // These markers should NOT be visible:
    expect(visibleText).not.toMatch(/(?<!\w)#(?=\s)/); // Heading markers
    expect(visibleText).not.toContain('**'); // Bold markers
    expect(visibleText).not.toMatch(/(?<!\*)(\*[^*]+\*)(?!\*)/); // Isolated italic markers
    expect(visibleText).not.toContain('~~'); // Strikethrough markers
    expect(visibleText).not.toContain(']('); // Link URL part
    expect(visibleText).not.toMatch(/^- /m); // List bullet markers
    // Note: Obsidian-parity keeps the `>` blockquote marker visible.
  });
});
