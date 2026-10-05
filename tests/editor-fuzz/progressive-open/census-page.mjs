// L6b harness: drives the shipped editor.html bundle through `?census`
// (src/features/editor/milkdown/chunkCensusHook.ts) and compares, for one
// markdown string, the whole-document parse against the finest chunked parse:
// serialization (what a first edit would write) AND the ProseMirror doc JSON.
// Synthetic inputs only. Not in CI.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

export const BUNDLE = path.resolve(process.cwd(), 'build/native-editor/editor.html');

export async function openCensusPage() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${pathToFileURL(BUNDLE).href}?census`);
  await page.waitForFunction(
    () => typeof window.__futoChunkCensus === 'function' && window.__futoEditorMounted === true,
    null,
    { timeout: 30000 },
  );
  return { browser, page, errors };
}

/** Returns {whole, chunked, wasChunked, chunks, aborted, docEqual, wholeDoc, chunkedDoc}. */
export async function compare(page, markdown) {
  return page.evaluate((md) => {
    const view = () => window.__futoProseMirrorView();
    window.__futoSerializeCensus(md); // whole load (CENSUS_WHOLE)
    const wholeDoc = view().state.doc;
    const wholeJson = JSON.stringify(wholeDoc.toJSON());
    let wholeCheckError = null;
    try {
      wholeDoc.check();
    } catch (e) {
      wholeCheckError = String(e);
    }
    const r = window.__futoChunkCensus(md); // whole, then finest chunked; view ends on chunked
    const chunkedDoc = view().state.doc;
    const chunkedJson = JSON.stringify(chunkedDoc.toJSON());
    let checkError = null;
    try {
      chunkedDoc.check();
    } catch (e) {
      checkError = String(e);
    }
    return {
      ...r,
      docEqual: wholeJson === chunkedJson,
      wholeDoc: wholeJson,
      chunkedDoc: chunkedJson,
      checkError,
      wholeCheckError,
    };
  }, markdown);
}
