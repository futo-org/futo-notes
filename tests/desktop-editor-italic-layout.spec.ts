import { expect, test } from '@playwright/test';

test('a fallback italic face keeps the next paragraph at the heading row boundary', async ({
  page,
}) => {
  await page.route('**/italic-layout', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
    <link rel="stylesheet" href="/src/styles/desktop-fonts.css?direct">
    <link rel="stylesheet" href="/src/features/editor/desktop/desktopEditor.css?direct">
    <style>
      /* Make the fallback's baseline differ on every host, even with a warm font cache. */
      @font-face {
        font-family: 'Fallback Italic';
        src: url('/src/fonts/plus-jakarta-sans/PlusJakartaSans-Italic-latin.woff2');
        font-style: italic;
        font-weight: 200 800;
        ascent-override: 115%;
        descent-override: 10%;
      }
      .desktop-editor .italic { font-family: 'Fallback Italic'; }
    </style>
    <div class="desktop-editor"><div class="chunk"><div class="line heading h1">Plain <span class="italic">italic</span></div><div class="line">Next paragraph</div></div></div>
  `,
    }),
  );
  await page.goto('/italic-layout');
  const faces = await page.evaluate(
    async () => (await document.fonts.load('italic 700 24px "Fallback Italic"')).length,
  );
  expect(faces).toBe(1);
  const { spacing, rowHeight } = await page
    .locator('.line')
    .evaluateAll(([heading, paragraph]) => ({
      spacing: paragraph.getBoundingClientRect().top - heading.getBoundingClientRect().top,
      rowHeight: parseFloat(getComputedStyle(heading).lineHeight),
    }));
  expect(spacing).toBe(rowHeight);
});
