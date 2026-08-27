import { expect, test } from '@playwright/test';

test('desktop language selection applies immediately', async ({ page }) => {
  await page.goto('/');
  const settingsButton = page.locator('.sidebar-settings-btn');
  await expect(settingsButton).toHaveAttribute('aria-label', 'Open settings');
  await settingsButton.click();

  const languageHeading = page.locator('.settings-language-heading');
  await expect(languageHeading.locator('.settings-language-heading-icon')).toBeVisible();
  await expect(languageHeading.locator('.settings-language-heading-icon')).toHaveAttribute(
    'aria-hidden',
    'true',
  );

  await expect(page.locator('select.settings-language-select')).toHaveCount(0);
  const languagePickerTrigger = page.locator('.settings-language-trigger');
  await expect(languagePickerTrigger).toHaveAccessibleName('Language System');
  await expect(languagePickerTrigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(languagePickerTrigger).toHaveAttribute('aria-expanded', 'false');

  await languagePickerTrigger.click();
  const languageOptions = page.getByRole('listbox', { name: 'Language' });
  await expect(languageOptions).toBeVisible();
  await expect(languageOptions.getByRole('option')).toHaveText(['System', 'English', '简体中文']);
  await expect(languageOptions).toHaveCSS('border-top-width', '0px');
  await expect(languageOptions.getByRole('option').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.locator('.settings-title').click();
  await expect(languageOptions).not.toBeVisible();

  await languagePickerTrigger.click();
  await expect(languageOptions).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(languageOptions).not.toBeVisible();
  await expect(languagePickerTrigger).toBeFocused();

  await languagePickerTrigger.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(languagePickerTrigger).toHaveAccessibleName('Language English');

  await languagePickerTrigger.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.locator('.settings-title')).toHaveText('设置');
  await expect(page.locator('.settings-section-title', { hasText: '语言' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('.note-body')).toHaveAttribute('dir', 'ltr');
  await expect(settingsButton).toHaveAttribute('aria-label', '打开设置');
  await expect(languagePickerTrigger).toHaveAccessibleName('语言 简体中文');

  await languagePickerTrigger.click();
  const localizedLanguageOptions = page.getByRole('listbox', { name: '语言' });
  await expect(localizedLanguageOptions.getByRole('option')).toHaveText([
    '跟随系统',
    'English',
    '简体中文',
  ]);
  await page.getByRole('option', { name: '跟随系统' }).click();

  await expect(page.locator('.settings-title')).toHaveText('Settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('desktop language picker keeps visible keyboard focus in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  await page.locator('.sidebar-settings-btn').click();

  const languagePickerTrigger = page.getByRole('button', { name: 'Language System' });
  await languagePickerTrigger.focus();

  await expect(languagePickerTrigger).toHaveCSS('outline-style', 'solid');
  await expect(languagePickerTrigger).toHaveCSS('outline-width', '2px');

  await languagePickerTrigger.press('ArrowDown');
  const selectedLanguageOption = page.getByRole('option', { name: 'System' });
  await expect(selectedLanguageOption).toBeFocused();
  await expect(selectedLanguageOption).toHaveCSS('outline-style', 'solid');
  await expect(selectedLanguageOption).toHaveCSS('outline-width', '2px');
});

test('desktop language selection preserves live markdown decorations', async ({ page }) => {
  const table = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |

More text`;
  await page.goto('/#/note/new');
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');
  await page.evaluate((content) => {
    const editorView = (window as any).__cmGetView?.();
    if (!editorView) throw new Error('CM EditorView not found');
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: content },
      selection: { anchor: content.length },
    });
  }, table);
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();

  const renderedTable = page.locator('.sf-table');
  await expect(renderedTable).toBeVisible();
  await page.locator('.sidebar-settings-btn').click();
  await page.locator('.settings-language-trigger').click();
  await page.getByRole('option', { name: '简体中文' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(renderedTable).toBeVisible();
  await expect(page.locator('[data-table-control-action="dragColumn"]').first()).toHaveAttribute(
    'aria-label',
    '拖动列',
  );
});
