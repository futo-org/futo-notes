// Phase 1 of the visual-similarity oracle: pixel-level diff between
// FUTO Notes and Obsidian screenshots, run on a curated subset of
// scenarios after both editors have a shared neutral theme injected.
//
// Phase 2 (LLM judge) is *not* this module — it's the workflow where
// the user asks Claude Code to "review the visual report" and Claude
// reads the saved screenshot pairs via its Read tool and surfaces
// differences. No API call, no continuous CI gate, just an
// on-demand second opinion when pixel diff is too noisy.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SCREENSHOTS_DIR = path.join(REPO, 'factory/captures/screenshots');
const NEUTRAL_THEME = readFileSync(path.join(REPO, 'factory/themes/neutral.css'), 'utf8');

// Scenarios that exercise distinct visual structure. Keep tight —
// pixel diff is fragile and we'd rather look at ~30 carefully than
// 264 carelessly. Each entry should produce a structurally distinct
// rendering — variants that only differ in token text aren't worth
// the screenshot/diff cost.
export const VISUAL_SCENARIO_NAMES = new Set([
  // Headings
  'h1-basic',
  'h2-basic',
  'h3-basic',
  'h4-basic',
  'h5-basic',
  'h6-basic',
  'heading-with-emphasis',
  // Inline emphasis
  'bold-basic',
  'italic-basic',
  'strikethrough-basic',
  'bold-italic-basic',
  'italic-underscore-basic',
  'bold-underscore-basic',
  // Code
  'inline-code-basic',
  'fenced-code-basic',
  'fenced-code-ruby',
  // Links / wikilinks
  'link-basic',
  'wikilink-basic',
  // Lists
  'ul-basic',
  'ol-basic',
  'task-unchecked',
  'task-checked',
  // Blockquotes
  'blockquote-basic',
  'nested-blockquote',
  // Block-level
  'hr-basic',
  // Tags
  'tag-basic',
  // GFM
  'gfm-table-with-alignment',
]);

export async function injectNeutralTheme(page: Page): Promise<void> {
  await page.addStyleTag({ content: NEUTRAL_THEME });
}

// Returns the absolute file path the screenshot was saved to, or null
// if the editor target wasn't found.
//
// We don't screenshot the whole `.cm-content` — Obsidian's content
// element fills the viewport (with chrome like "0 backlinks / 2 words"
// peeking in at the bottom), while SF's is tight to text. That size
// asymmetry alone produced ~5–14% pixel drift on every scenario,
// drowning out real divergences. Instead, measure the union of every
// rendered `.cm-line` rect and clip the page screenshot to that
// bounding box plus a small padding. Both editors then deliver a
// shot that's just the rendered text, deterministic in size.
export async function captureEditorScreenshot(
  page: Page,
  scenarioName: string,
  side: 'sf' | 'ob',
): Promise<string | null> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  // Fenced code languages from @codemirror/language-data are loaded lazily.
  // Give nested parsers a frame to attach before taking the visual oracle shot.
  await page.waitForTimeout(250);
  const clip = await page.evaluate(() => {
    const root = document.querySelector('.cm-content[data-factory-target="true"]');
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    const elements = Array.from(
      root.querySelectorAll('.cm-line, .cm-md-code-lang-label'),
    ) as HTMLElement[];
    if (elements.length === 0) return null;
    let top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const el of elements) {
      const r = el.getBoundingClientRect();
      // Skip empty trailing lines that have no rendered text.
      if (r.height === 0) continue;
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(top) || !isFinite(bottom)) return null;
    const PAD = 2;
    // Width: clamp to a fixed comparison width so both editors have
    // the same horizontal canvas, regardless of their wrapper
    // padding. The editor surface is at least this wide in both.
    const WIDTH = Math.max(600, Math.ceil(right - rootRect.left) + PAD * 2);
    return {
      x: Math.max(0, Math.floor(rootRect.left) - PAD),
      y: Math.max(0, Math.floor(top) - PAD),
      width: WIDTH,
      height: Math.ceil(bottom - top) + PAD * 2,
    };
  });
  if (!clip) return null;
  const out = path.join(SCREENSHOTS_DIR, `${scenarioName}.${side}.png`);
  await page.screenshot({ path: out, clip, animations: 'disabled' });
  return out;
}

export interface VisualDiffResult {
  scenarioName: string;
  sfPath: string;
  obPath: string;
  diffPath: string;
  // Total mismatching pixels.
  diffPixels: number;
  // Diff pixels / total pixels in the smaller image.
  diffRatio: number;
  // Whether sizes matched. When false, the comparison is forced to
  // crop both images to the smaller bounding box first.
  sizesMatched: boolean;
  width: number;
  height: number;
}

// Threshold — fraction of pixels that may differ before we flag a
// scenario as a visual divergence. 0.10 = 10% tolerance.
//
// The baseline drift between SF (Chromium-on-Linux through Vite) and
// Obsidian (Electron-on-Linux through CDP) is 4–8% on every scenario
// regardless of content, dominated by font-rendering metrics for the
// same nominal font ("Arial"). Below 10% reports as same-shape; above
// is a structural divergence worth opening the report for. The
// LLM-judge phase doesn't care about the threshold — it reads the
// pair regardless.
export const VISUAL_DIFF_TOLERANCE = 0.1;

export function diffScreenshots(
  scenarioName: string,
  sfPath: string,
  obPath: string,
): VisualDiffResult | null {
  if (!existsSync(sfPath) || !existsSync(obPath)) return null;
  const sf = PNG.sync.read(readFileSync(sfPath));
  const ob = PNG.sync.read(readFileSync(obPath));
  const w = Math.min(sf.width, ob.width);
  const h = Math.min(sf.height, ob.height);
  const sizesMatched = sf.width === ob.width && sf.height === ob.height;

  // Crop to common bounding box if needed. pixelmatch requires same
  // dimensions; rather than reject mismatched-size pairs, take the
  // overlap so the comparison still surfaces structural drift.
  const sfCropped = cropToCommon(sf, w, h);
  const obCropped = cropToCommon(ob, w, h);
  const diff = new PNG({ width: w, height: h });

  const diffPixels = pixelmatch(sfCropped.data, obCropped.data, diff.data, w, h, {
    threshold: 0.1,
    includeAA: false,
  });

  const diffPath = path.join(SCREENSHOTS_DIR, `${scenarioName}.diff.png`);
  writeFileSync(diffPath, PNG.sync.write(diff));

  return {
    scenarioName,
    sfPath,
    obPath,
    diffPath,
    diffPixels,
    diffRatio: diffPixels / (w * h),
    sizesMatched,
    width: w,
    height: h,
  };
}

function cropToCommon(
  src: PNG,
  w: number,
  h: number,
): { data: Buffer; width: number; height: number } {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (src.width * y + x) * 4;
      const di = (w * y + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}
