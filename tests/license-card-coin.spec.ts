// Part of the License card suite: the mock and the fixtures are in lib/licenseCard.ts.
// The plate's states are in license-card.spec.ts.

import { test, expect } from '@playwright/test';
import { LICENSED_V2, openLicenseSettings } from './lib/licenseCard';

test.describe('License card', () => {
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
    // The plate sits in a scrolling Settings dialog. The coin stops its
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
  // delivers every radian; this proves a tap on the real canvas ADDS a turn to
  // what the coin owes rather than restarting one.
  //
  // It reads the queue, not the screen. Two pixel-based versions of this test
  // were red on CI for a true behavior, and the reason is the same both times:
  // past a certain speed a spinning disc looks no more different between two
  // frames than a slower one does, so churn stops tracking speed exactly where
  // this test needs it to. Measuring how long the coin stayed loud instead of
  // how loud it got only moved the problem — twenty queued turns spin at the
  // payout cap for seconds, and under load that window read anywhere from
  // 412ms to 4881ms across three runs of the same code. The queue itself is
  // one number and it is exact. What the screen does with it is the test above
  // this one, which clicks with a real mouse and watches the coin move.
  test('licensed: eight fast clicks on the coin queue eight turns', async ({ page }) => {
    const BURST = 8;

    await openLicenseSettings(page, LICENSED_V2);
    await expect(page.locator('.supporter-coin-stage-live')).toBeAttached({ timeout: 15000 });

    // The coin binds plain `pointerdown`/`pointerup` listeners on its mount, so
    // dispatched events go through exactly the handler a real click does — and
    // it already expects a synthetic pointer id, since `setPointerCapture`
    // throws for one. Dispatching them here rather than through `page.mouse`
    // keeps the burst inside a single frame: over the protocol a click costs
    // ~100ms, long enough that the coin pays off most of a burst while it is
    // still being delivered.
    const owedAfter = (taps: number): Promise<number> =>
      page.evaluate((count) => {
        const mount = document.querySelector<HTMLElement>('.supporter-coin-stage');
        if (mount === null) throw new Error('the coin has no mount');
        const coin = window.__supporterCoin;
        if (coin === undefined) throw new Error('the coin published no handle');
        const at = mount.getBoundingClientRect();
        const options = {
          clientX: at.left + at.width / 2,
          clientY: at.top + at.height / 2,
          bubbles: true,
        };
        const before = coin.turnsOwed();
        for (let tap = 0; tap < count; tap += 1) {
          const pointerId = 1000 + tap;
          mount.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerId }));
          mount.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerId }));
        }
        return coin.turnsOwed() - before;
      }, taps);

    // No frame runs between the taps and the reading, so nothing has been paid
    // off yet: one tap owes exactly one turn and a burst owes exactly its
    // count. The behavior this replaced, which set the debt to one turn per
    // click instead of adding one, owes 1 either way.
    expect(await owedAfter(1)).toBeCloseTo(1, 5);
    expect(await owedAfter(BURST)).toBeCloseTo(BURST, 5);
  });
});
