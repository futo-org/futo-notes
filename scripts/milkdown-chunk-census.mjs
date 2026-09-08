#!/usr/bin/env node
/**
 * Chunk-equivalence census — the proof progressive open rests on.
 *
 * Progressive open (docs/plan/milkdown-transition.md §5, issue #105) parses a
 * large note in top-level chunks and appends them one idle slice at a time.
 * That is only safe if a chunked parse produces the SAME document as a
 * whole-document parse, for every note, and "for every note" is not something a
 * hand-written test suite can claim. So this asks the real editor, over a real
 * corpus, one note at a time:
 *
 *     serialize(chunked(note)) === serialize(whole(note))   ?
 *
 * It drives the shipped `editor.html` bundle through `?census` (see
 * `src/editor-embed/chunkCensusHook.ts`) at the FINEST granularity the chunk
 * planner allows — one cut at every safe boundary it can find — because every
 * boundary is a place the two parses could disagree, and a coarse plan would
 * exercise almost none of them.
 *
 * Usage:
 *   node scripts/milkdown-chunk-census.mjs [--corpus <path>] [--limit N]
 *                                          [--jobs N] [--report <path>]
 *                                          [--dump-divergences <path>]
 *
 * The corpus is a `.jsonl` or `.jsonl.gz` file, one JSON object per line, with
 * the note body under `body`, `content`, or `text`. It defaults to
 * `~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz`, is NEVER read into
 * the report, and is not in this repo — the corpus is real user notes.
 *
 * `--serialize` runs a DIFFERENT equivalence claim over the same corpus and
 * page harness: `blockSerializer.ts`'s per-top-level-block serialization
 * cache (the fix for the whole-document `getMarkdown()` cost on a settled
 * edit, docs/plan/milkdown-transition.md "Gate run, real app, 2026-09-06")
 * must produce the SAME bytes as Milkdown's own serializer called directly.
 * It drives `window.__futoSerializeCensus` (chunkCensusHook.ts) instead of
 * `window.__futoChunkCensus`, and defaults its report to
 * `build/serialize-census/report.md` rather than `build/chunk-census/report.md`.
 *
 * Exit status is the gate: 0 only when every note matched.
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

const REPO_ROOT = process.cwd();
const BUNDLE = path.resolve(REPO_ROOT, 'build/native-editor/editor.html');
const DEFAULT_CORPUS = path.join(
  homedir(),
  'Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz',
);

function parseArgs(argv) {
  const args = {
    corpus: DEFAULT_CORPUS,
    limit: Infinity,
    jobs: 8,
    report: null,
    dumpDivergences: null,
    skipBuild: false,
    serialize: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--corpus') ((args.corpus = value), (i += 1));
    else if (flag === '--limit') ((args.limit = Number(value)), (i += 1));
    else if (flag === '--jobs') ((args.jobs = Number(value)), (i += 1));
    else if (flag === '--report') ((args.report = value), (i += 1));
    else if (flag === '--dump-divergences') ((args.dumpDivergences = value), (i += 1));
    else if (flag === '--skip-build') args.skipBuild = true;
    else if (flag === '--serialize') args.serialize = true;
    else {
      console.error(`Unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  if (args.report === null) {
    args.report = args.serialize
      ? 'build/serialize-census/report.md'
      : 'build/chunk-census/report.md';
  }
  return args;
}

/** Reads note bodies out of a `.jsonl` / `.jsonl.gz` corpus, newest field wins. */
async function* readCorpus(corpusPath, limit) {
  const raw = createReadStream(corpusPath);
  const stream = corpusPath.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    if (index >= limit) break;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A malformed corpus line is the corpus's problem, not the editor's.
      index += 1;
      continue;
    }
    const body = record.body ?? record.content ?? record.text;
    if (typeof body === 'string' && body.length > 0) yield { index, body };
    index += 1;
  }
}

/**
 * One browser page holding one editor, reused across notes. Rebuilding the
 * editor per note would dominate the run and prove nothing extra — the hook
 * loads each note from scratch anyway.
 */
async function openCensusPage(browser, serialize) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    console.error('page error:', error.message);
  });
  await page.goto(`${pathToFileURL(BUNDLE).href}?census`);
  await page.waitForFunction(
    (name) => typeof window[name] === 'function',
    serialize ? '__futoSerializeCensus' : '__futoChunkCensus',
  );
  return { context, page };
}

/**
 * The `--serialize` census: does `blockSerializer.ts`'s per-block cache
 * produce the same bytes as Milkdown's own serializer, over the same corpus
 * and page harness as the chunk-equivalence census above? Split out rather
 * than interleaved with `main()`'s chunk-census loop because the two share
 * only the corpus reader and the worker pages — the verdict, stats, and
 * report shape are unrelated claims.
 */
async function runSerializeCensus(args, workers, browser) {
  const stats = { notes: 0, equal: 0, divergent: 0, failed: 0 };
  const divergences = [];
  const startedAt = Date.now();

  async function run(worker, note) {
    let result;
    try {
      result = await worker.page.evaluate((body) => window.__futoSerializeCensus(body), note.body);
    } catch (error) {
      stats.failed += 1;
      divergences.push({ index: note.index, kind: 'harness', detail: String(error) });
      return;
    }
    stats.notes += 1;
    if (result.whole === result.blocks) {
      stats.equal += 1;
      return;
    }
    stats.divergent += 1;
    divergences.push({
      index: note.index,
      kind: 'divergence',
      whole: result.whole,
      blocks: result.blocks,
    });
  }

  const inFlight = new Map();
  for await (const note of readCorpus(args.corpus, args.limit)) {
    if (inFlight.size >= workers.length) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled);
    }
    const worker = workers.find((w) => !inFlight.has(w));
    inFlight.set(
      worker,
      run(worker, note).then(() => worker),
    );
    if (stats.notes > 0 && stats.notes % 2000 === 0) {
      process.stdout.write(`  ${stats.notes} notes, ${stats.divergent} divergent\n`);
    }
  }
  await Promise.all(inFlight.values());

  for (const worker of workers) await worker.context.close();
  await browser.close();

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const report = [
    '# Block-serializer equivalence census',
    '',
    `Corpus: \`${path.basename(args.corpus)}\` — note CONTENT is never recorded here.`,
    `Bundle: \`build/native-editor/editor.html\` (rebuilt this run: ${!args.skipBuild}).`,
    `Claim: a FRESH BlockSerializer's serialize() of a note equals Milkdown's own serializer called directly on the same document.`,
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Notes processed | ${stats.notes} |`,
    `| **Equivalent** | **${stats.equal}** |`,
    `| **Divergent** | **${stats.divergent}** |`,
    `| Harness failures | ${stats.failed} |`,
    `| Wall clock | ${elapsedS}s |`,
    '',
    stats.divergent === 0 && stats.failed === 0
      ? `Every one of the ${stats.notes} notes serialized identically through the block cache and the direct serializer.`
      : `Divergent note indices: ${divergences
          .slice(0, 50)
          .map((d) => d.index)
          .join(', ')}${divergences.length > 50 ? ', …' : ''}`,
    '',
  ].join('\n');

  mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  writeFileSync(path.resolve(args.report), report);
  process.stdout.write(`\n${report}\nReport written to ${args.report}\n`);

  if (args.dumpDivergences && divergences.length > 0) {
    // Carries note CONTENT — for local triage only, never committed.
    mkdirSync(path.dirname(path.resolve(args.dumpDivergences)), { recursive: true });
    writeFileSync(
      path.resolve(args.dumpDivergences),
      divergences.map((d) => JSON.stringify(d)).join('\n'),
    );
    process.stdout.write(`Divergences dumped to ${args.dumpDivergences} (contains note text)\n`);
  }

  process.exit(stats.divergent === 0 && stats.failed === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.corpus)) {
    console.error(`No corpus at ${args.corpus}`);
    console.error('Pass --corpus <path> to a .jsonl/.jsonl.gz of notes.');
    process.exit(2);
  }

  if (!args.skipBuild) {
    // Never census a stale bundle: a green run against yesterday's editor is a
    // false green (AGENTS.md M11).
    console.log('==> building editor.html');
    execFileSync(
      path.resolve('node_modules/.bin/vite'),
      ['build', '--config', 'vite.editor.config.ts'],
      { stdio: 'inherit', cwd: REPO_ROOT },
    );
  }
  if (!existsSync(BUNDLE)) {
    console.error(`No bundle at ${BUNDLE}`);
    process.exit(2);
  }

  const browser = await chromium.launch();
  const workers = await Promise.all(
    Array.from({ length: Math.max(1, args.jobs) }, () => openCensusPage(browser, args.serialize)),
  );

  if (args.serialize) {
    await runSerializeCensus(args, workers, browser);
    return;
  }

  const stats = {
    notes: 0,
    chunked: 0,
    declined: 0,
    aborted: 0,
    equal: 0,
    divergent: 0,
    failed: 0,
    chunksTotal: 0,
  };
  const divergences = [];
  const startedAt = Date.now();

  /** Runs one note on one page, folding the verdict into `stats`. */
  async function run(worker, note) {
    let result;
    try {
      result = await worker.page.evaluate((body) => window.__futoChunkCensus(body), note.body);
    } catch (error) {
      stats.failed += 1;
      divergences.push({ index: note.index, kind: 'harness', detail: String(error) });
      return;
    }
    stats.notes += 1;
    /* A note the LOADER abandoned mid-flight — it refused a chunk and reloaded
     * the note whole — proves nothing here: its "chunked" serialization came
     * from a whole-document parse, so comparing the two is comparing a whole
     * parse with itself. Counted on its own line, never as a match. */
    if (result.aborted) {
      stats.aborted += 1;
      return;
    }
    if (result.wasChunked) {
      stats.chunked += 1;
      stats.chunksTotal += result.chunks;
    } else {
      stats.declined += 1;
    }
    if (result.whole === result.chunked) {
      stats.equal += 1;
      return;
    }
    stats.divergent += 1;
    divergences.push({
      index: note.index,
      kind: 'divergence',
      chunks: result.chunks,
      whole: result.whole,
      chunked: result.chunked,
    });
  }

  // Round-robin across the pages, one note in flight per page.
  const inFlight = new Map();
  for await (const note of readCorpus(args.corpus, args.limit)) {
    if (inFlight.size >= workers.length) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled);
    }
    const worker = workers.find((w) => !inFlight.has(w));
    inFlight.set(
      worker,
      run(worker, note).then(() => worker),
    );
    if (stats.notes > 0 && stats.notes % 2000 === 0) {
      process.stdout.write(`  ${stats.notes} notes, ${stats.divergent} divergent\n`);
    }
  }
  await Promise.all(inFlight.values());

  for (const worker of workers) await worker.context.close();
  await browser.close();

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const report = [
    '# Milkdown chunked-parse equivalence census',
    '',
    `Corpus: \`${path.basename(args.corpus)}\` — note CONTENT is never recorded here.`,
    `Bundle: \`build/native-editor/editor.html\` (rebuilt this run: ${!args.skipBuild}).`,
    `Granularity: finest the planner allows (a cut at every safe boundary).`,
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Notes processed | ${stats.notes} |`,
    `| Chunked (progressive path exercised) | ${stats.chunked} |`,
    `| Declined by the planner (loaded whole) | ${stats.declined} |`,
    `| Abandoned by the loader mid-flight (proves nothing — see below) | ${stats.aborted} |`,
    `| Mean chunks per chunked note | ${stats.chunked ? (stats.chunksTotal / stats.chunked).toFixed(1) : '—'} |`,
    `| **Equivalent to a whole-document parse** | **${stats.equal}** |`,
    `| **Divergent** | **${stats.divergent}** |`,
    `| Harness failures | ${stats.failed} |`,
    `| Wall clock | ${elapsedS}s |`,
    '',
    stats.divergent === 0 && stats.failed === 0
      ? `Every one of the ${stats.chunked} notes that took the progressive path parsed identically chunked and whole.`
      : `Divergent note indices: ${divergences
          .slice(0, 50)
          .map((d) => d.index)
          .join(', ')}${divergences.length > 50 ? ', …' : ''}`,
    stats.aborted > 0
      ? `\n${stats.aborted} note(s) were abandoned by the loader mid-flight: it refused a chunk ` +
        'the plugin chain had eaten and reloaded the note whole. That is the safe fallback working, ' +
        'not an equivalence result, so those notes are excluded from the counts above.'
      : '',
    '',
    'The equivalence claim is against the plugin chain THIS BUNDLE SHIPS. The compat plugin set ' +
      '(issue #99) is not in it yet, so re-run this after #99 lands — the acceptance criterion for ' +
      'issue #105 asks for equivalence under the final chain.',
    '',
  ].join('\n');

  mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  writeFileSync(path.resolve(args.report), report);
  process.stdout.write(`\n${report}\nReport written to ${args.report}\n`);

  if (args.dumpDivergences && divergences.length > 0) {
    // Carries note CONTENT — for local triage only, never committed.
    mkdirSync(path.dirname(path.resolve(args.dumpDivergences)), { recursive: true });
    writeFileSync(
      path.resolve(args.dumpDivergences),
      divergences.map((d) => JSON.stringify(d)).join('\n'),
    );
    process.stdout.write(`Divergences dumped to ${args.dumpDivergences} (contains note text)\n`);
  }

  process.exit(stats.divergent === 0 && stats.failed === 0 ? 0 : 1);
}

await main();
