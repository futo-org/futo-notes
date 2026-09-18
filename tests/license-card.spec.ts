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
const MASKED_KEY = '····-····-····-····-····-····-····-6UJV';

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
    await expect(page.locator('.license-pitch')).toContainText("FUTO's mission");
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
    await expect(page.locator('.license-pitch')).toContainText("FUTO's mission");

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

  // Clicks QUEUE (@justin 2026-09-18). The unit test proves the arithmetic
  // delivers every radian; this proves the coin ON SCREEN is still working
  // through them.
  //
  // It times how LONG the coin keeps moving, not how hard it is moving at one
  // chosen instant. The instant version read the churn 1.5s after the clicks
  // and wanted eight clicks to beat one by 3x; that holds on a machine with a
  // GPU and fails on CI's software WebGL, where a frame can exceed the
  // renderer's own 1/20s delta clamp and the whole animation runs in slow
  // motion — one turn is then still going at 1.5s, both readings saturate the
  // 48x48 sample, and the job goes red on a true behaviour (17.9 vs 19.9,
  // job 256050). A DURATION ratio survives that: slow motion stretches both
  // measurements by the same factor.
  //
  // Red-proved against the behaviour it replaced, which set the debt to one
  // turn per click instead of adding one: queued, one tap keeps the coin moving
  // 671ms and eight keep it 2397ms (3.6x); with the debt reset per tap, eight
  // taps keep it moving no longer than one does (0.5-0.9x over three runs).
  // The 2x bar sits between the two, and four copies of this test racing on one
  // machine still pass.
  test('licensed: eight fast clicks on the coin queue eight turns', async ({ page }) => {
    await openLicenseSettings(page, LICENSED_V2);
    await expect(page.locator('.supporter-coin-stage-live')).toBeAttached({ timeout: 15000 });

    await page.locator('.supporter-coin-stage').scrollIntoViewIfNeeded();

    // How far apart two frames 100ms apart are, averaged over the coin. The
    // coin never stops — it has a resting spin — so this never reaches zero,
    // and "settled" means "back down to the resting figure".
    const install = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.supporter-coin-stage canvas');
        if (canvas === null) throw new Error('the coin has no canvas');
        const scratch = document.createElement('canvas');
        scratch.width = 48;
        scratch.height = 48;
        const context = scratch.getContext('2d');
        if (context === null) throw new Error('no 2d context for the sampler');
        const sample = (): Uint8ClampedArray => {
          context.drawImage(canvas, 0, 0, 48, 48);
          return context.getImageData(0, 0, 48, 48).data;
        };
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        // Per FRAME, not per millisecond. The coin integrates its turn against
        // the frame delta (clamped at 1/20s), so a slow renderer turns it
        // further per frame but no further per frame than a fast one does —
        // which is what makes this reading comparable across machines. Measured
        // over a wall-clock window instead, a fast renderer turns the coin most
        // of a revolution between two reads, and a disc that has turned 150
        // degrees looks no more different than one that has turned 90: the
        // number stops growing with speed exactly where this test needs it to.
        const churn = async (): Promise<number> => {
          let previous = sample();
          let total = 0;
          const frames = 4;
          for (let frame = 0; frame < frames; frame += 1) {
            await nextFrame();
            const current = sample();
            let difference = 0;
            for (let i = 0; i < current.length; i += 4) {
              difference += Math.abs(current[i] - previous[i]);
            }
            total += difference / (current.length / 4);
            previous = current;
          }
          return total / frames;
        };
        const globals = window as unknown as {
          __coinChurn: () => Promise<number>;
          __coinMovingFor: (ceiling: number, capMs: number) => Promise<number>;
          __coinTapBurst: (taps: number) => void;
        };
        globals.__coinChurn = churn;
        // The taps are dispatched here rather than driven through
        // `page.mouse`, which costs ~100ms a click over the protocol — long
        // enough that the coin pays off most of the burst WHILE it is being
        // delivered, which is the difference this test is trying to read. The
        // coin binds plain `pointerdown`/`pointerup` listeners on its mount, so
        // these go through exactly the handler a real click does (and it
        // already expects a synthetic pointer id: `setPointerCapture` is
        // wrapped for it). That real clicks reach the coin at all is the test
        // above this one.
        globals.__coinTapBurst = (taps) => {
          const mount = document.querySelector<HTMLElement>('.supporter-coin-stage');
          if (mount === null) throw new Error('the coin has no mount');
          const at = mount.getBoundingClientRect();
          const clientX = at.left + at.width / 2;
          const clientY = at.top + at.height / 2;
          for (let tap = 0; tap < taps; tap += 1) {
            const pointerId = 1000 + tap;
            const options = { pointerId, clientX, clientY, bubbles: true };
            mount.dispatchEvent(new PointerEvent('pointerdown', options));
            mount.dispatchEvent(new PointerEvent('pointerup', options));
          }
        };
        // Milliseconds the coin spent ABOVE `ceiling` — the time of the LAST
        // loud read, not the time the settle was confirmed. Confirmation costs
        // two more reads (two, so one frame the renderer happened to skip
        // cannot be mistaken for the coin settling), and a read is a fixed
        // number of FRAMES, so on a loaded machine that tail is hundreds of
        // milliseconds. Counted, it lands on both measurements equally and
        // squeezes the ratio towards 1 exactly when the machine is slowest —
        // which is where this test has to keep working.
        globals.__coinMovingFor = async (ceiling, capMs) => {
          const started = performance.now();
          let lastLoudAt = started;
          let quiet = 0;
          while (performance.now() - started < capMs) {
            if ((await churn()) <= ceiling) {
              quiet += 1;
              if (quiet >= 2) break;
            } else {
              quiet = 0;
              lastLoudAt = performance.now();
            }
          }
          return lastLoudAt - started;
        };
      });

    await install();

    // The resting figure this run: measured, never assumed, because it depends
    // on how fast this machine can draw.
    const resting = await page.evaluate(() =>
      (window as unknown as { __coinChurn: () => Promise<number> }).__coinChurn(),
    );
    expect(resting, 'the coin is not turning at all — nothing to measure').toBeGreaterThan(0);
    const ceiling = resting * 2;

    const movingFor = (taps: number): Promise<number> =>
      page.evaluate(
        ([count, limit, cap]) => {
          const globals = window as unknown as {
            __coinTapBurst: (taps: number) => void;
            __coinMovingFor: (ceiling: number, capMs: number) => Promise<number>;
          };
          globals.__coinTapBurst(count);
          return globals.__coinMovingFor(limit, cap);
        },
        [taps, ceiling, 30_000],
      );

    const afterOne = await movingFor(1);
    const afterEight = await movingFor(8);

    expect(
      afterEight,
      `one tap kept the coin moving ${Math.round(afterOne)}ms, eight kept it ` +
        `${Math.round(afterEight)}ms (resting churn ${resting.toFixed(2)}) — ` +
        'eight taps should outlast one, not restart it',
    ).toBeGreaterThan(afterOne * 2);
  });
});
