import { test, expect, Page } from '@playwright/test';

/**
 * An image widget is width-constrained (`max-width: 100%`), so its rendered
 * height depends on the editor's content width. The widget used to pin the
 * wrapper to the height measured at first load, and the wrapper is
 * `overflow: hidden` — so any later width INCREASE clipped the bottom of the
 * image with no way to recover.
 *
 * On iOS both triggers are routine: a device rotation, and the shared editor
 * WebView being adopted into real bounds after its zero-size prewarm.
 */

const NARROW = { width: 420, height: 900 };
const WIDE = { width: 1000, height: 900 };

async function setupEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(
    () => typeof (window as unknown as CmWindow).__cmGetView === 'function',
  );
}

interface CmWindow {
  __cmGetView?: () => {
    state: { doc: { length: number; toString(): string } };
    dispatch: (spec: unknown) => void;
  } | null;
}

/** A real, wide PNG built in-page, so it loads as a `data:` source. */
async function insertWideImage(page: Page): Promise<void> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 500;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.fillStyle = 'red';
    context.fillRect(0, 0, 1600, 500);
    return canvas.toDataURL('image/png');
  });

  await page.evaluate((url) => {
    const view = (window as unknown as CmWindow).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const text = `above\n\n![](${url})\n\nbelow`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.dispatch({ selection: { anchor: 0 } });
  }, dataUrl);

  await page.waitForSelector('.cm-md-image-wrapper img');
  await page.waitForFunction(() => {
    const img = document.querySelector('.cm-md-image-wrapper img') as HTMLImageElement | null;
    return !!img && img.complete && img.getBoundingClientRect().height > 0;
  });
}

async function measureImageFootprint(
  page: Page,
): Promise<{ wrapperHeight: number; imageHeight: number }> {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.cm-md-image-wrapper') as HTMLElement;
    const img = wrapper.querySelector('img') as HTMLImageElement;
    return {
      wrapperHeight: Math.round(wrapper.getBoundingClientRect().height),
      imageHeight: Math.round(img.getBoundingClientRect().height),
    };
  });
}

test.describe('Image widget across editor width changes', () => {
  test('does not clip the image after the editor gets wider', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await setupEditor(page);
    await insertWideImage(page);

    const narrow = await measureImageFootprint(page);
    expect(narrow.imageHeight).toBeGreaterThan(0);
    expect(narrow.imageHeight).toBeLessThanOrEqual(narrow.wrapperHeight + 1);

    await page.setViewportSize(WIDE);
    // The image grows taller because it is width-constrained.
    await page.waitForFunction((previousHeight) => {
      const img = document.querySelector('.cm-md-image-wrapper img') as HTMLImageElement | null;
      return !!img && img.getBoundingClientRect().height > previousHeight;
    }, narrow.imageHeight);

    const wide = await measureImageFootprint(page);
    // The whole image must still be inside its `overflow: hidden` wrapper.
    expect(wide.imageHeight).toBeLessThanOrEqual(wide.wrapperHeight + 1);
  });

  test("keeps CodeMirror's height map in step with the grown image", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await setupEditor(page);
    await insertWideImage(page);

    const narrowHeight = (await measureImageFootprint(page)).imageHeight;
    await page.setViewportSize(WIDE);
    // Wait on the resize actually landing, not on a fixed delay (AGENTS.md M15).
    await page.waitForFunction((previousHeight) => {
      const img = document.querySelector('.cm-md-image-wrapper img') as HTMLImageElement | null;
      return !!img && img.getBoundingClientRect().height > previousHeight;
    }, narrowHeight);

    // Measured from the IMAGE's own box, not the wrapper's: when the wrapper is
    // too short the image overflows it and lands on top of the following text,
    // which is the same staleness that jerks momentum scrolling on the native
    // shells.
    const overlap = await page.evaluate(() => {
      const img = document.querySelector('.cm-md-image-wrapper img') as HTMLImageElement;
      const imageBottom = img.getBoundingClientRect().bottom;
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const below = lines.find((line) => line.textContent?.includes('below'));
      if (!below) throw new Error('line after the image not found');
      return Math.round(imageBottom - below.getBoundingClientRect().top);
    });

    expect(overlap).toBeLessThanOrEqual(1);
  });
});
