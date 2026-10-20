// The Steel Ledger plate, one test per state (docs/spec/license.md § States and
// copy; docs/plan/license-ship.md § Phase 4). The route-fulfilment mock that lets a
// browser see the non-default states is in lib/licenseCard.ts. The coin tests are in
// license-card-coin.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import {
  KEY,
  MASKED_KEY,
  UNLICENSED,
  LICENSED_V2,
  LICENSED_V1,
  EXPIRED,
  mockLicense,
  openLicenseSettings,
  rowValue,
  buyButton,
  removeButton,
  type LicenseViewFixture,
} from './lib/licenseCard';

test.describe('License card', () => {
  // The letterhead — badge, eyebrow, uppercase product name — belongs to a card,
  // and Unlicensed has no card. Stripping it down to a heading, the reason and
  // one button is the shape Grayjay, FUTO Keyboard and Immich all use
  // (@justin 2026-09-18).
  test('unlicensed: the ask, no card chrome, Buy as the only filled button', async ({ page }) => {
    await openLicenseSettings(page, UNLICENSED);

    await expect(page.locator('.license-badge')).toHaveCount(0);
    await expect(page.locator('.license-eyebrow')).toHaveCount(0);
    await expect(page.locator('.license-name')).toHaveCount(0);

    // No coin, and no empty well standing in for one: an empty circle read as
    // something that failed to load rather than as "no license".
    await expect(page.locator('.license-well')).toHaveCount(0);
    await expect(page.locator('.supporter-coin')).toHaveCount(0);

    // Nothing to put in the ledger, so there is no ledger. A lone blank Key row
    // would be the same void the well was.
    await expect(page.locator('.license-row')).toHaveCount(0);

    // The ask is the state's headline, and the reason — one paragraph, no more —
    // sits above the button rather than under it.
    await expect(page.locator('.license-pitch-headline')).toHaveText('Pay for FUTO Notes');
    await expect(page.locator('.license-pitch')).toHaveCount(1);
    await expect(page.locator('.license-pitch')).toContainText('is paid for by you');
    await expect(page.locator('.license-explanation')).toHaveCount(0);

    await expect(buyButton(page)).toBeVisible();
    await expect(removeButton(page)).toHaveCount(0);
    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'I already paid' }),
    ).toBeVisible();
    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'Lost your key?' }),
    ).toBeVisible();
    // The Buy slab is the one filled button on the plate.
    await expect(page.locator('.license-plate .license-btn-primary')).toHaveCount(1);
  });

  test('licensed (v2): no badge, the coin, a masked key, and no date or term', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    await expect(page.locator('.license-badge')).toHaveCount(0);
    await expect(page.locator('.license-well .supporter-coin')).toBeVisible();

    // Key is the whole ledger. Nothing records a purchase date and nothing
    // limits a license, so neither row exists to be filled or left blank.
    await expect(page.locator('.license-row')).toHaveCount(1);
    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);

    await expect(buyButton(page)).toHaveCount(0);
    await expect(removeButton(page)).toBeVisible();
    await expect(page.locator('.license-explanation')).toHaveText(
      'Thank you for purchasing FUTO Notes.',
    );
    // The ask belongs to Unlicensed alone.
    await expect(page.locator('.license-pitch-headline')).toHaveCount(0);
  });

  test('licensed (v1): a dateless activation renders the same card', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V1);

    await expect(page.locator('.license-well .supporter-coin')).toBeVisible();
    await expect(page.locator('.license-row')).toHaveCount(1);
    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);
  });

  test('expired: the Expired badge, the key, and Renew rather than Buy', async ({ page }) => {
    await openLicenseSettings(page, EXPIRED);

    await expect(page.locator('.license-badge')).toHaveText('Expired');
    await expect(page.locator('.supporter-coin')).toHaveCount(0);

    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);
    // Someone Expired has paid once already: same mission paragraph, no
    // headline, and Renew rather than Buy.
    await expect(page.locator('.license-pitch-headline')).toHaveCount(0);
    await expect(page.locator('.license-pitch')).toHaveCount(1);
    await expect(page.locator('.license-pitch')).toContainText('is paid for by you');

    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'Renew', exact: true }),
    ).toBeVisible();
    await expect(buyButton(page)).toHaveCount(0);
    await expect(removeButton(page)).toHaveCount(0);
  });

  // One click reveals the key as plain text and that is all it does. Copying is
  // left to select-and-copy on purpose (@justin 2026-09-17): a key should not be
  // one click from the clipboard.
  test('the masked key reveals the full key, with no copy button', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    const reveal = page.getByRole('button', { name: 'Show key' });
    await expect(reveal).toHaveText(MASKED_KEY);
    await expect(page.getByRole('button', { name: 'Copy key' })).toHaveCount(0);

    await reveal.click();

    await expect(rowValue(page, 'Key')).toContainText(KEY);
    // Revealed, the key is no longer a control at all.
    await expect(page.locator('.license-row button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy key' })).toHaveCount(0);
  });

  // Taking the Copy button away only works if select-and-copy actually does.
  // `body` sets `user-select: none` (src/styles/base.css) — the rule that gives
  // the app its native, non-web feel — and it inherits straight down onto the
  // revealed key, so the one value a buyer must get OUT of the app could not be
  // selected at all. Justin hit that on his own desktop build on 2026-09-19.
  //
  // Two assertions, because either alone would miss it: the computed value, and
  // a real Range over the span. The desktop ships on WebKit, which honours
  // `user-select: none` against the Selection API too — a scripted selection
  // there returns the empty string rather than the key.
  test('the revealed key is selectable, so select-and-copy can reach it', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    // The mask is a control, not a value: it stays unselectable, so a
    // double-click on it reveals rather than highlighting thirty-two dots.
    await expect(page.locator('.license-key-masked')).toHaveCSS('user-select', 'none');

    await page.getByRole('button', { name: 'Show key' }).click();

    const key = page.locator('.license-key');
    await expect(key).toHaveText(KEY);
    await expect(key).toHaveCSS('user-select', 'text');
    await expect(key).toHaveCSS('-webkit-user-select', 'text');

    const selected = await key.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    expect(selected).toBe(KEY);
  });
});

// The ambient label — the bottom-left corner of the sidebar, and the only
// place outside Settings the license was ever mentioned (docs/spec/license.md
// § Where it appears). These do not open Settings: the whole point is what the
// corner says while the user is just looking at their notes.
test.describe('Sidebar ambient license label', () => {
  const footer = (page: Page) => page.locator('.sidebar-footer-license');

  async function openShell(page: Page, view: LicenseViewFixture): Promise<void> {
    await mockLicense(page, view);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // The label is read asynchronously and must never delay the first paint
    // (M1), so wait on the shell rather than on the label: waiting on the label
    // would make "it never arrives" indistinguishable from "it is absent".
    await expect(page.locator('.sidebar-settings-btn')).toBeVisible();
  }

  // A paid license says nothing outside Settings (@justin 2026-09-21). This
  // corner used to read "Licensed since {date}", so the reward for paying was a
  // permanent line of chrome about having paid, one keystroke from the editor.
  test('says nothing at all once licensed', async ({ page }) => {
    await openShell(page, LICENSED_V2);

    await expect(footer(page)).toHaveCount(0);
    // The element is removed, not blanked: an empty button is still a click
    // target and is still announced.
    await expect(page.locator('.sidebar-footer')).toHaveText('');
  });

  // v1 is what production mints and already showed nothing. Locked so the two
  // licensed shapes cannot drift apart again.
  test('says nothing for a v1 license either', async ({ page }) => {
    await openShell(page, LICENSED_V1);

    await expect(footer(page)).toHaveCount(0);
  });

  test('still reads Unlicensed with no license, and opens the License section', async ({
    page,
  }) => {
    await openShell(page, UNLICENSED);

    await expect(footer(page)).toHaveText('Unlicensed');

    await footer(page).click();
    await expect(page.locator('.settings-title')).toBeVisible();
    await expect(page.locator('.license-plate')).toBeVisible();
  });

  // Expired is the one state that has to explain itself, so it keeps the label.
  test('still reads Unlicensed once the license has expired', async ({ page }) => {
    await openShell(page, EXPIRED);

    await expect(footer(page)).toHaveText('Unlicensed');
  });
});
