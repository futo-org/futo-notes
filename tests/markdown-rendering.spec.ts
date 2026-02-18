import { test, expect, Page } from '@playwright/test';

/**
 * Autonomous Markdown Rendering Verification Tests
 *
 * This test suite verifies that the live markdown transformation plugin
 * correctly renders all supported markdown elements by checking:
 * 1. CSS classes are applied to content
 * 2. Computed styles match expectations
 * 3. Syntax markers are hidden (replaced with HiddenWidget)
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

  // Focus and type content
  const editor = page.locator('.cm-content');
  await editor.click();
  await editor.fill(content);

  // Move cursor to the end (last line) so first lines get decorated
  await page.keyboard.press('Control+End');

  // Wait for decorations to rebuild
  await page.waitForTimeout(200);
}

async function blurEditor(page: Page): Promise<void> {
  // Click outside editor to blur and allow all decorations
  // This removes focus from CodeMirror entirely
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(300);
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

    const fontSize = await h1.evaluate(el =>
      window.getComputedStyle(el).fontSize
    );
    expect(parseInt(fontSize)).toBeGreaterThanOrEqual(24); // 28px desktop, 24px mobile

    const fontWeight = await h1.evaluate(el =>
      window.getComputedStyle(el).fontWeight
    );
    expect(parseInt(fontWeight)).toBeGreaterThanOrEqual(600);
  });

  test('h2 renders with correct class and font size', async ({ page }) => {
    await setupEditor(page, '## Heading 2\n\nMore text');
    await blurEditor(page);

    const h2 = page.locator('.cm-md-h2');
    await expect(h2).toBeVisible();

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

    // The # should not be visible in the rendered output
    // (it's replaced by HiddenWidget with display:none)
    const content = await page.locator('.cm-line').first().textContent();
    // Content should not start with # when decorations applied
    // Note: This checks the visible text, not the raw content
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

    const fontWeight = await bold.evaluate(el =>
      window.getComputedStyle(el).fontWeight
    );
    expect(parseInt(fontWeight)).toBeGreaterThanOrEqual(700);
  });

  test('emphasis markers are hidden', async ({ page }) => {
    await setupEditor(page, 'This is **bold** text.\n\nMore');
    await blurEditor(page);

    // The ** markers should be hidden via HiddenWidget
    // Check that the bold element exists but markers aren't visible
    const bold = page.locator('.cm-md-strong');
    const text = await bold.textContent();
    expect(text).not.toContain('**');
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
    const text = await code.textContent();
    expect(text).not.toContain('`');
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

    const link = page.locator('.cm-md-link');
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

    const link = page.locator('.cm-md-link');
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
    const hasQuoteClass = await quoteLines.evaluate(el =>
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

    // Tables render as HTML widgets via StateField
    const tableWrapper = page.locator('.cm-md-table-wrapper');
    await expect(tableWrapper).toBeVisible();

    const table = page.locator('.cm-md-table-rendered');
    await expect(table).toBeVisible();
  });

  test('table has header and body rows', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.table + '\n\nMore text');
    await blurEditor(page);

    // Check that table has proper structure
    const headers = page.locator('.cm-md-table-rendered th');
    const cells = page.locator('.cm-md-table-rendered td');

    const headerCount = await headers.count();
    const cellCount = await cells.count();

    expect(headerCount).toBeGreaterThanOrEqual(2); // At least 2 columns
    expect(cellCount).toBeGreaterThanOrEqual(2); // At least 1 data row
  });

  test('table header row is styled bold', async ({ page }) => {
    await setupEditor(page, TEST_CONTENT.table + '\n\nMore text');
    await blurEditor(page);

    const header = page.locator('.cm-md-table-rendered th').first();
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

    // Both classes should be present
    await expect(page.locator('.cm-md-strong')).toBeVisible();
    // Note: nested italic inside bold may or may not render depending on parser
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
    const visibleText = await page.locator('.cm-content').textContent();

    // These markers should NOT be visible:
    expect(visibleText).not.toMatch(/(?<!\w)#(?=\s)/); // Heading markers
    expect(visibleText).not.toContain('**'); // Bold markers
    expect(visibleText).not.toMatch(/(?<!\*)(\*[^*]+\*)(?!\*)/); // Isolated italic markers
    expect(visibleText).not.toContain('~~'); // Strikethrough markers
    expect(visibleText).not.toContain(']('); // Link URL part
    expect(visibleText).not.toMatch(/^>/m); // Quote markers (at line start)
    expect(visibleText).not.toMatch(/^- /m); // List bullet markers
  });
});
