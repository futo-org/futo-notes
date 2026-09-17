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
 *  mints today. It renders the same card as a v2 one — since 2026-09-17 the
 *  card shows neither a purchase date nor a term, so the two differ in nothing
 *  the user can see. */
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

/** When set, any key the user submits activates and lands on this view — which
 *  is the only way to reach the *moment* of activation from a browser. */
async function mockLicense(
  page: Page,
  view: LicenseViewFixture,
  activatesTo?: LicenseViewFixture,
): Promise<void> {
  await page.route('**/src/lib/platform/license.ts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `
        export const UNLICENSED = { state: 'unlicensed', issuedAt: null, expiresAt: null, key: null };
        const VIEW = ${JSON.stringify(view)};
        const ACTIVATED = ${JSON.stringify(activatesTo ?? null)};
        export async function readLicenseStatus() { return VIEW; }
        export async function submitLicenseKey() {
          return ACTIVATED === null
            ? { outcome: 'invalid', view: VIEW }
            : { outcome: 'activated', view: ACTIVATED };
        }
        export async function clearLicense() { return UNLICENSED; }
        export async function readLicenseLinks() { return { buy: '', support: '' }; }
        export async function takePendingLicenseLink() { return null; }
        export async function subscribeLicenseLinks() { return () => {}; }
      `,
    });
  });
}

/** The celebration canvas: the plate's own, never the coin's WebGL stage. */
function showerCanvas(page: Page) {
  return page.locator('.license-plate > canvas');
}

/** Types any key into the plate and activates it. */
async function activate(page: Page): Promise<void> {
  await page.locator('.license-plate').getByRole('button', { name: 'Enter license key' }).click();
  await page.locator('#license-key-input').fill('FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78');
  await page.locator('.license-plate').getByRole('button', { name: 'Activate' }).click();
}

async function openLicenseSettings(
  page: Page,
  view: LicenseViewFixture,
  activatesTo?: LicenseViewFixture,
): Promise<void> {
  await mockLicense(page, view, activatesTo);
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
  test('unlicensed: badge, no well, no rows, the ask, Buy as the only filled button', async ({
    page,
  }) => {
    await openLicenseSettings(page, UNLICENSED);

    await expect(page.locator('.license-badge')).toHaveText('Unlicensed');
    // No coin, and no empty well standing in for one: an empty circle read as
    // something that failed to load rather than as "no license".
    await expect(page.locator('.license-well')).toHaveCount(0);
    await expect(page.locator('.supporter-coin')).toHaveCount(0);

    // Nothing to put in the ledger, so there is no ledger. A lone blank Key row
    // would be the same void the well was.
    await expect(page.locator('.license-row')).toHaveCount(0);

    // The ask is the state's headline, not a footnote under the button.
    await expect(page.locator('.license-pitch-headline')).toHaveText("You don't own a license.");
    await expect(page.locator('.license-pitch')).toContainText('buy a license');

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
      'Thank you for paying for FUTO Notes.',
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
    // Someone Expired has paid once already, so they get Renew, not the ask.
    await expect(page.locator('.license-pitch-headline')).toHaveCount(0);

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
  // FUTOpay's checkout page throws coins on a purchase and @justin asked for the
  // same moment here, with one difference that is the whole point: it is
  // confined to the plate. The canvas is the plate's own child, so "inside the
  // container" is structural rather than something a screenshot has to judge.
  test('activating a license throws a burst of coins inside the plate', async ({ page }) => {
    await openLicenseSettings(page, UNLICENSED, LICENSED_V2);
    await expect(showerCanvas(page)).toHaveCount(0);

    await activate(page);

    // The plate is now the Licensed card, and the coins are on it.
    await expect(page.locator('.license-well .supporter-coin')).toBeVisible();
    await expect(showerCanvas(page)).toBeAttached();

    // Something is actually drawn — an empty canvas would pass a existence test.
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.license-plate > canvas');
      if (canvas === null) return 0;
      const scratch = document.createElement('canvas');
      scratch.width = 120;
      scratch.height = 60;
      const context = scratch.getContext('2d');
      if (context === null) return 0;
      context.drawImage(canvas, 0, 0, 120, 60);
      const { data } = context.getImageData(0, 0, 120, 60);
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 40) opaque += 1;
      }
      return opaque;
    });
    expect(painted).toBeGreaterThan(50);

    // And it cleans itself up rather than sitting on the plate forever (M5).
    await expect(showerCanvas(page)).toHaveCount(0, { timeout: 10000 });
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    // Unlike the coin in the well, which still has to render, a burst that does
    // not move is nothing — so it is skipped outright rather than frozen.
    test('no coin burst is thrown at all', async ({ page }) => {
      await openLicenseSettings(page, UNLICENSED, LICENSED_V2);
      await activate(page);

      await expect(page.locator('.license-well')).toBeAttached();
      await expect(showerCanvas(page)).toHaveCount(0);
    });
  });

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

  // A click is a drag that went nowhere, and it spins the coin once around fast.
  // There is no rotation to read from the outside, so this measures the only
  // thing that is observable: how much the rendered pixels change per frame. The
  // click's turn is ~12.6 rad/s at its peak against an ambient 1.25 rad/s, so
  // the gap is an order of magnitude and the 1.5x floor below is generous.
  test('licensed: clicking the coin spins it a full turn', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);
    await expect(page.locator('.supporter-coin-stage-live')).toBeAttached({ timeout: 15000 });

    const stage = page.locator('.supporter-coin-stage');
    await stage.scrollIntoViewIfNeeded();

    const churn = async (): Promise<number> =>
      page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('.supporter-coin-stage canvas');
        if (canvas === null) return 0;
        const scratch = document.createElement('canvas');
        scratch.width = 48;
        scratch.height = 48;
        const context = scratch.getContext('2d');
        if (context === null) return 0;
        const sample = (): Uint8ClampedArray => {
          context.drawImage(canvas, 0, 0, 48, 48);
          return context.getImageData(0, 0, 48, 48).data;
        };
        let peak = 0;
        let previous = sample();
        for (let step = 0; step < 8; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const current = sample();
          let total = 0;
          for (let i = 0; i < current.length; i += 4) {
            total += Math.abs(current[i] - previous[i]);
          }
          peak = Math.max(peak, total / (current.length / 4));
          previous = current;
        }
        return peak;
      });

    const ambient = await churn();
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const clicked = await churn();

    expect(clicked).toBeGreaterThan(ambient * 1.5);
  });
});
