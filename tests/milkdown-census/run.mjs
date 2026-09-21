#!/usr/bin/env node
/**
 * Round-trip census: run every note in a corpus through the real Milkdown
 * editor and record what came back.
 *
 *   node tests/milkdown-census/run.mjs --variant compat
 *   node tests/milkdown-census/run.mjs --variant baseline --out build/milkdown-census/baseline
 *   node tests/milkdown-census/run.mjs --vault ~/Documents/futo-notes   # local leg
 *   node tests/milkdown-census/run.mjs --diff build/milkdown-census/baseline
 *
 * `--variant baseline` runs the unpatched upstream preset, which is how the
 * "did anything regress" comparison is produced from this same harness rather
 * than from a set of numbers nobody can re-derive.
 *
 * Output (default `build/milkdown-census/<variant>/`, gitignored):
 *   results.jsonl  one record per note; flagged notes also carry round1/round2
 *   summary.json   the aggregate counters
 * Corpus content is never written to either file beyond the flagged notes'
 * round-trip text, and vault runs are for local eyes only — see the README.
 */
import { createReadStream } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import { chromium } from 'playwright';

import { buildCensusPage } from './build.mjs';
import { FLAG_ORDER, classify } from './detectors.mjs';

const DEFAULT_CORPUS = path.join(
  process.env.HOME ?? '',
  'Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz',
);

function parseArgs(argv) {
  const args = {
    variant: 'compat',
    pool: Number(process.env.POOL_SIZE ?? 8),
    corpus: DEFAULT_CORPUS,
    vault: null,
    limit: Infinity,
    out: null,
    diff: null,
    timeoutMs: 20_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--variant':
        args.variant = value;
        i += 1;
        break;
      case '--pool':
        args.pool = Number(value);
        i += 1;
        break;
      case '--corpus':
        args.corpus = value;
        i += 1;
        break;
      case '--vault':
        args.vault = value;
        i += 1;
        break;
      case '--limit':
        args.limit = Number(value);
        i += 1;
        break;
      case '--out':
        args.out = value;
        i += 1;
        break;
      case '--diff':
        args.diff = value;
        i += 1;
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(value);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (args.variant !== 'compat' && args.variant !== 'baseline') {
    throw new Error(`--variant must be compat or baseline, got ${args.variant}`);
  }
  args.out ??= path.join('build/milkdown-census', args.variant);
  return args;
}

async function* readCorpus(file, limit) {
  const stream = createReadStream(file).pipe(createGunzip());
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let idx = 0;
  for await (const line of lines) {
    if (idx >= limit) break;
    if (!line.trim()) continue;
    const note = JSON.parse(line);
    yield { id: String(idx), body: note.body ?? '', meta: { source_type: note.source_type } };
    idx += 1;
  }
}

function* walkVault(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walkVault(full);
    else if (name.endsWith('.md')) yield full;
  }
}

async function* readVault(dir, limit) {
  let idx = 0;
  for (const file of walkVault(dir)) {
    if (idx >= limit) break;
    yield { id: path.relative(dir, file), body: readFileSync(file, 'utf8'), meta: {} };
    idx += 1;
  }
}

async function processNote(page, variant, note, timeoutMs) {
  const load = (markdown) =>
    page.evaluate(([v, m]) => window.__futoCensus.load(v, m), [variant, markdown]);
  const withTimeout = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);

  const started = Date.now();
  const round1 = await withTimeout(load(note.body));
  const round2 = await withTimeout(load(round1.markdown));
  const round3 =
    round1.markdown === round2.markdown ? null : await withTimeout(load(round2.markdown));

  const flags = classify({ body: note.body, round1, round2, round3 });
  const record = {
    id: note.id,
    body_len: note.body.length,
    time_ms: Date.now() - started,
    ...note.meta,
    flags,
  };
  if (Object.keys(flags).length > 0) {
    record.round1 = round1.markdown;
    record.round2 = round2.markdown;
  }
  return record;
}

function readResults(dir) {
  const file = path.join(dir, 'results.jsonl');
  const byId = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    byId.set(record.id, record.flags ?? {});
  }
  return byId;
}

function reportDiff(baselineDir, currentDir) {
  const before = readResults(baselineDir);
  const after = readResults(currentDir);
  const regressions = [];
  const fixes = [];
  for (const [id, afterFlags] of after) {
    const beforeFlags = before.get(id) ?? {};
    for (const flag of FLAG_ORDER) {
      if (afterFlags[flag] && !beforeFlags[flag]) regressions.push({ id, flag });
      if (beforeFlags[flag] && !afterFlags[flag]) fixes.push({ id, flag });
    }
  }
  console.log(
    `\nvs ${baselineDir}: ${fixes.length} flags cleared, ${regressions.length} newly raised`,
  );
  const byFlag = (rows) => {
    const counts = {};
    for (const row of rows) counts[row.flag] = (counts[row.flag] ?? 0) + 1;
    return counts;
  };
  console.log('  cleared    :', JSON.stringify(byFlag(fixes)));
  console.log('  newly raised:', JSON.stringify(byFlag(regressions)));
  if (regressions.length > 0) {
    console.log('  first 25 regressions:');
    for (const row of regressions.slice(0, 25)) console.log(`    ${row.flag} ${row.id}`);
  }
  return regressions;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = await buildCensusPage();
  mkdirSync(args.out, { recursive: true });

  const source = args.vault
    ? readVault(args.vault, args.limit)
    : readCorpus(args.corpus, args.limit);
  const browser = await chromium.launch();
  const pages = [];
  for (let i = 0; i < args.pool; i += 1) {
    const page = await browser.newPage();
    await page.goto(url);
    pages.push(page);
  }

  const records = [];
  const summary = { notes: 0, harness_failures: 0, editor_failures: 0 };
  for (const flag of FLAG_ORDER) summary[flag] = 0;
  const startedAt = Date.now();

  const iterator = source[Symbol.asyncIterator]();
  let exhausted = false;
  async function worker(page) {
    for (;;) {
      if (exhausted) return;
      const { value: note, done } = await iterator.next();
      if (done) {
        exhausted = true;
        return;
      }
      let record;
      try {
        record = await processNote(page, args.variant, note, args.timeoutMs);
      } catch (error) {
        record = { id: note.id, body_len: note.body.length, flags: {}, error: String(error) };
        summary.harness_failures += 1;
        // A page that timed out mid-evaluate is not trustworthy any more.
        await page.goto(url).catch(() => {});
      }
      records.push(record);
      summary.notes += 1;
      for (const flag of Object.keys(record.flags)) summary[flag] += 1;
      if (summary.notes % 500 === 0) {
        const rate = summary.notes / ((Date.now() - startedAt) / 1000);
        process.stderr.write(`  ${summary.notes} notes (${rate.toFixed(0)}/s)\n`);
      }
    }
  }
  await Promise.all(pages.map((page) => worker(page)));
  await browser.close();

  records.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  writeFileSync(
    path.join(args.out, 'results.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  summary.variant = args.variant;
  summary.source = args.vault ? 'vault' : path.basename(args.corpus);
  summary.duration_s = Math.round((Date.now() - startedAt) / 1000);
  writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log(JSON.stringify(summary, null, 2));
  if (args.diff) {
    const regressions = reportDiff(args.diff, args.out);
    if (regressions.length > 0) process.exitCode = 1;
  }
}

await main();
