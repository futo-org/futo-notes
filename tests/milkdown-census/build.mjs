// Bundles the census page (tests/milkdown-census/entry.ts) with esbuild.
//
// The bundle imports @futo-notes/editor/milkdown-compat from source, so the
// census always exercises the same compat plugins the app ships — there is no
// copy to drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
export const outDir = path.join(repoRoot, 'build/milkdown-census');
export const pageUrl = `file://${path.join(outDir, 'page.html')}`;

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Milkdown census</title></head>
<body><script src="./bundle.js"></script></body></html>
`;

/** Builds the page if it is missing or stale; returns the file:// URL. */
export async function buildCensusPage() {
  mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(here, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(outDir, 'bundle.js'),
    absWorkingDir: repoRoot,
    alias: { '@futo-notes/editor': path.join(repoRoot, 'packages/editor/src') },
    logLevel: 'warning',
  });
  writeFileSync(path.join(outDir, 'page.html'), PAGE_HTML);
  return pageUrl;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCensusPage();
  console.log(`built ${pageUrl}`);
}
