// The census page, round-trip calls and mark-normalizing comparison shared by
// the editor-embed-milkdown-compat*.spec.ts suites, moved here verbatim from
// editor-embed-milkdown-compat.spec.ts.

import { test, type Page } from '@playwright/test';

import { buildCensusPage, outDir } from '../milkdown-census/build.mjs';

let pageUrl: string;

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
  content?: JsonNode[];
}

/**
 * A document (`doc.toJSON()`) with the one thing the house style re-spells in
 * the inline-mark tests below taken out: an emphasis or strong run's `marker`,
 * which records whether the FILE wrote `*` or `_` (a save writes `*` and only
 * falls back to `_` where two `*` runs would merge). Text runs that then carry
 * the same marks are one run, as `_a_*b*` saved as `*ab*` reads back.
 * Everything else — text, which marks, where they start and end, links,
 * structure, every other attribute — must match exactly. Deliberately
 * narrower than the census `houseDocument`, which also forgives
 * normalizations (whitespace at a line end, empty paragraphs, CR, layout)
 * these tests have no reason to.
 */
export function withoutMarkers(doc: unknown): string {
  const strip = (node: JsonNode): JsonNode => {
    const out: JsonNode = { ...node };
    if (node.marks) {
      out.marks = node.marks.map((mark) => {
        if (!mark.attrs || !('marker' in mark.attrs)) return mark;
        const { marker: _marker, ...attrs } = mark.attrs;
        return Object.keys(attrs).length > 0 ? { ...mark, attrs } : { type: mark.type };
      });
    }
    if (node.content) {
      const merged: JsonNode[] = [];
      for (const child of node.content.map(strip)) {
        const last = merged[merged.length - 1];
        const sameMarks = JSON.stringify(last?.marks) === JSON.stringify(child.marks);
        if (last?.type === 'text' && child.type === 'text' && sameMarks) {
          merged[merged.length - 1] = { ...last, text: `${last.text ?? ''}${child.text ?? ''}` };
        } else merged.push(child);
      }
      out.content = merged;
    }
    return out;
  };
  return JSON.stringify(strip(doc as JsonNode));
}

/**
 * Registers the census page for the calling spec file. One worker per file even
 * under `--fully-parallel` (the bench gate runs the suite that way): a file's
 * workers rebuilt the page at the same fixed path, so a second worker
 * overwrote it while the first was loading it and three tests read
 * `__futoCensus` as undefined. Each worker now builds into its own folder, so
 * separate compat files cannot overwrite each other either.
 */
export function useCensusPage(): void {
  test.describe.configure({ mode: 'default' });

  // Playwright reads the fixtures a hook wants from its first argument's destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(async ({}, testInfo) => {
    pageUrl = await buildCensusPage(`${outDir}/worker-${testInfo.workerIndex}`);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(pageUrl);
  });
}

/** One editor load: markdown in, the editor's own serialization back out. */
export async function roundTrip(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  return page.evaluate(
    ([v, m]) => window.__futoCensus.load(v as 'compat' | 'baseline', m).then((r) => r.markdown),
    [variant, markdown] as const,
  );
}

/** A plain-text paste into an empty editor, through Milkdown's clipboard plugin. */
export async function pastePlain(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  return page.evaluate(
    ([v, m]) => window.__futoCensus.pastePlainText(v as 'compat' | 'baseline', m),
    [variant, markdown] as const,
  );
}

/** Two loads: what the first save writes, and whether the second agrees. */
export async function twoSaves(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  const once = await roundTrip(page, variant, markdown);
  return { once, twice: await roundTrip(page, variant, once) };
}
