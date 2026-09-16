import { test, expect, Page } from '@playwright/test';

// The Steel Ledger plate, one test per state (docs/spec/license.md § States and
// copy; docs/plan/license-ship.md § Phase 4).
//
// The license *rules* live in Rust and the browser never reaches them: off
// Tauri `src/lib/platform/license.ts` answers "Unlicensed" for everything, so
// the only way to see the other states in a browser is to replace that module.
// The dev server serves it as a plain ESM module, so the mock is a route
// fulfilment — no product-code test hook, and nothing here re-implements a
// rule: the fixture *is* what Rust would have answered.
interface LicenseViewFixture {
  state: 'unlicensed' | 'licensed' | 'expired';
  issuedAt: string | null;
  expiresAt: string | null;
  key: string | null;
}

const KEY = 'AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV';
/** Seven masked groups of four U+00B7, then the real last four. */
const MASKED_KEY = '···· ···· ···· ···· ···· ···· ···· 6UJV';

const UNLICENSED: LicenseViewFixture = {
  state: 'unlicensed',
  issuedAt: null,
  expiresAt: null,
  key: null,
};
const LICENSED_V2: LicenseViewFixture = {
  state: 'licensed',
  issuedAt: '2026-06-15T12:00:00Z',
  expiresAt: '2029-06-15T12:00:00Z',
  key: KEY,
};
/** A v1 activation: no issue date and no expiry, which is what production
 *  mints today. The "Licensed since" row must be present and blank (D2). */
const LICENSED_V1: LicenseViewFixture = {
  state: 'licensed',
  issuedAt: null,
  expiresAt: null,
  key: KEY,
};
const EXPIRED: LicenseViewFixture = {
  state: 'expired',
  issuedAt: '2024-01-02T12:00:00Z',
  expiresAt: '2025-01-02T12:00:00Z',
  key: KEY,
};

async function mockLicense(page: Page, view: LicenseViewFixture): Promise<void> {
  await page.route('**/src/lib/platform/license.ts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `
        export const UNLICENSED = { state: 'unlicensed', issuedAt: null, expiresAt: null, key: null };
        const VIEW = ${JSON.stringify(view)};
        export async function readLicenseStatus() { return VIEW; }
        export async function submitLicenseKey() { return { outcome: 'invalid', view: VIEW }; }
        export async function clearLicense() { return UNLICENSED; }
        export async function readLicenseLinks() { return { buy: '', support: '' }; }
        export async function takePendingLicenseLink() { return null; }
        export async function subscribeLicenseLinks() { return () => {}; }
      `,
    });
  });
}

async function openLicenseSettings(page: Page, view: LicenseViewFixture): Promise<void> {
  await mockLicense(page, view);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
  await expect(page.locator('.license-plate')).toBeVisible();
}

/** The `dd` of the plate row whose `dt` is exactly this label. */
function rowValue(page: Page, label: string) {
  return page
    .locator('.license-row')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}

function buyButton(page: Page) {
  return page.locator('.license-plate').getByRole('button', { name: 'Buy a license' });
}

function removeButton(page: Page) {
  return page.locator('.license-plate').getByRole('button', { name: 'Remove license' });
}

test.describe('License card', () => {
  test('unlicensed: badge, empty well, blank rows, Buy as the only filled button', async ({
    page,
  }) => {
    await openLicenseSettings(page, UNLICENSED);

    await expect(page.locator('.license-badge')).toHaveText('Unlicensed');
    await expect(page.locator('.license-well [aria-label="No license"]')).toBeAttached();
    await expect(page.locator('.supporter-coin')).toHaveCount(0);

    // Every row is present in every state; a value the activation never carried
    // renders blank rather than being invented.
    await expect(rowValue(page, 'Key')).toHaveText('');
    await expect(rowValue(page, 'Licensed since')).toHaveText('');
    await expect(rowValue(page, 'Term')).toHaveText('');

    await expect(buyButton(page)).toBeVisible();
    await expect(removeButton(page)).toHaveCount(0);
    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'Enter license key' }),
    ).toBeVisible();
    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'Lost your key?' }),
    ).toBeVisible();
    // The Buy slab is the one filled button on the plate.
    await expect(page.locator('.license-plate .license-btn-primary')).toHaveCount(1);
  });

  test('licensed (v2): no badge, the coin, a masked key, a date and a term', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    await expect(page.locator('.license-badge')).toHaveCount(0);
    await expect(page.locator('.license-well .supporter-coin')).toBeVisible();

    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);
    await expect(rowValue(page, 'Licensed since')).not.toHaveText('');
    await expect(rowValue(page, 'Term')).toContainText('Valid until');

    await expect(buyButton(page)).toHaveCount(0);
    await expect(removeButton(page)).toBeVisible();
    await expect(page.locator('.license-explanation')).toHaveText(
      'Thank you for paying for FUTO Notes.',
    );
  });

  test('licensed (v1): the since row is present and blank, and the term is perpetual', async ({
    page,
  }) => {
    await openLicenseSettings(page, LICENSED_V1);

    await expect(rowValue(page, 'Licensed since')).toHaveText('');
    await expect(rowValue(page, 'Term')).toHaveText('Perpetual');
    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);
  });

  test('expired: the Expired badge, a dated term, and Renew rather than Buy', async ({ page }) => {
    await openLicenseSettings(page, EXPIRED);

    await expect(page.locator('.license-badge')).toHaveText('Expired');
    await expect(page.locator('.supporter-coin')).toHaveCount(0);

    await expect(rowValue(page, 'Key')).toHaveText(MASKED_KEY);
    await expect(rowValue(page, 'Licensed since')).not.toHaveText('');
    await expect(rowValue(page, 'Term')).toContainText('Expired');

    await expect(
      page.locator('.license-plate').getByRole('button', { name: 'Renew', exact: true }),
    ).toBeVisible();
    await expect(buyButton(page)).toHaveCount(0);
    await expect(removeButton(page)).toHaveCount(0);
  });

  test('the masked key reveals the full key and offers Copy', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    const reveal = page.getByRole('button', { name: 'Show key' });
    await expect(reveal).toHaveText(MASKED_KEY);
    await expect(page.getByRole('button', { name: 'Copy key' })).toHaveCount(0);

    await reveal.click();

    await expect(rowValue(page, 'Key')).toContainText(KEY);
    await expect(page.getByRole('button', { name: 'Show key' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy key' })).toBeVisible();
  });

  // The coin is a Blender model (assets/coin/futo-coin.glb) lit by an exported
  // studio environment, loaded at runtime by three.js. Asserting the canvas
  // exists would prove almost nothing — a failed fetch, a black material or a
  // camera pointed at nothing all leave a canvas behind. So this reads the
  // PIXELS back and insists they are gold.
  //
  // `preserveDrawingBuffer` on the renderer is what makes that read-back
  // possible; without it the canvas samples as fully transparent.
  test('licensed: the 3D coin loads its model and renders gold', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);

    // The stage only gets this class once buildCoin() has resolved a handle,
    // which means both the .glb and the .hdr arrived and the first frame drew.
    const stage = page.locator('.supporter-coin-stage-live');
    await expect(stage).toBeAttached({ timeout: 15000 });
    // The plate sits well down a scrolling Settings sheet. The coin stops its
    // own render loop while off screen (it is one keystroke from the editor),
    // so a test that never scrolls to it is reading a frame that happens to be
    // left over rather than one the app is actually drawing.
    await stage.scrollIntoViewIfNeeded();
    await expect(stage.locator('canvas')).toBeVisible();

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.supporter-coin-stage canvas');
      if (canvas === null) return null;
      const scratch = document.createElement('canvas');
      scratch.width = 64;
      scratch.height = 64;
      const context = scratch.getContext('2d');
      if (context === null) return null;
      context.drawImage(canvas, 0, 0, 64, 64);
      const { data } = context.getImageData(0, 0, 64, 64);
      let opaque = 0;
      let golden = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 128) continue;
        opaque += 1;
        // Gold is red >= green > blue by a clear margin. This rejects both a
        // black coin (no environment) and a white one (blown-out tone mapping).
        if (r > 70 && r >= g && g > b + 25) golden += 1;
      }
      return { opaque, golden };
    });

    expect(sample).not.toBeNull();
    // The coin covers a good share of its box; a handful of stray pixels would
    // mean the camera is framing empty space.
    expect(sample!.opaque).toBeGreaterThan(400);
    // Nearly every pixel the coin covers should be gold. The hole and the
    // corners are transparent and already excluded by the alpha test.
    expect(sample!.golden / sample!.opaque).toBeGreaterThan(0.8);
  });

  // Drag-to-turn is the whole reason the coin is a model and not a picture.
  test('licensed: dragging across the coin turns it', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);
    await expect(page.locator('.supporter-coin-stage-live')).toBeAttached({ timeout: 15000 });

    const stage = page.locator('.supporter-coin-stage');
    await stage.scrollIntoViewIfNeeded();
    const box = (await stage.boundingBox())!;
    const midY = box.y + box.height / 2;

    // `data-turning` is set by the pointer controller, so this proves the drag
    // was actually claimed rather than falling through to the page.
    await page.mouse.move(box.x + box.width * 0.2, midY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, midY, { steps: 12 });
    await expect(stage).toHaveAttribute('data-turning', 'true');
    await page.mouse.up();
    await expect(stage).toHaveAttribute('data-turning', 'false');
  });
});
