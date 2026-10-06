// Bundles the census page (tests/milkdown-census/entry.ts) with esbuild.
//
// The bundle imports @futo-notes/editor/milkdown-compat and the app's own
// parse-side plugins (wikilinks, the table-cell `<br>` reader) from source, so
// the census always exercises what the app ships — there is no copy to drift.
// The one stand-in is the note index the wikilink plugin renders with (see
// `appAliases`).
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

/**
 * The app's `$features/…` and `$shared/…` import aliases (vite.config.ts),
 * except `$features/notes/notes.svelte`, the app's note cache: a Svelte runes
 * module esbuild cannot compile, which the wikilink plugin only reads to render
 * a link and fill its autocomplete. It resolves to `noteIndexStub.ts`.
 */
const appAliases = {
  name: 'app-aliases',
  setup(build) {
    build.onResolve({ filter: /^\$features\/notes\/notes\.svelte$/ }, () => ({
      path: path.join(here, 'noteIndexStub.ts'),
    }));
    build.onResolve({ filter: /^\$(features|shared)\// }, (args) => {
      const [, area, rest] = /^\$(features|shared)\/(.*)$/.exec(args.path);
      return build.resolve(`./${rest}`, {
        kind: args.kind,
        resolveDir: path.join(repoRoot, 'src', area),
      });
    });
  },
};

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
    plugins: [appAliases],
    logLevel: 'warning',
  });
  writeFileSync(path.join(outDir, 'page.html'), PAGE_HTML);
  return pageUrl;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCensusPage();
  console.log(`built ${pageUrl}`);
}
