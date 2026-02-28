#!/usr/bin/env node

import path from 'node:path';

import { CACHE_DIR, REPORTS_DIR } from './lib/constants.mjs';
import { buildNormalizedEntities } from './lib/entity-normalization.mjs';
import { ensureDir, readJsonFile, writeJsonFile } from './lib/fs-utils.mjs';
import { sha256 } from './lib/hash.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.notesDir) {
  console.error('Missing required argument: --notes-dir <path>');
  process.exit(1);
}

const notesDir = path.resolve(args.notesDir);
const cacheFile = path.resolve(args.cacheFile || path.join(CACHE_DIR, 'extractions-cache.json'));
const outputFile = path.resolve(args.output || path.join(REPORTS_DIR, 'entities.json'));

await ensureDir(path.dirname(outputFile));

const cache = await readJsonFile(cacheFile);
if (!cache || typeof cache !== 'object' || !cache.datasets) {
  throw new Error(`Invalid or missing cache file: ${cacheFile}`);
}

const datasetKey = sha256(notesDir).slice(0, 16);
const dataset = cache.datasets[datasetKey];
if (!dataset) {
  throw new Error(`No cached dataset for notes dir: ${notesDir}`);
}

const noteEntries = Object.values(dataset.notes ?? {})
  .filter(entry => entry && typeof entry === 'object' && entry.extraction)
  .map(entry => ({
    noteId: entry.noteId,
    sourcePath: entry.sourcePath,
    title: entry.title,
    extraction: entry.extraction,
  }))
  .sort((a, b) => a.noteId.localeCompare(b.noteId));

const normalized = buildNormalizedEntities(noteEntries, {
  fuzzyThreshold: args.fuzzyThreshold,
  lowConfidenceThreshold: args.lowConfidenceThreshold,
});

const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    notesDir,
    datasetKey,
    noteCount: noteEntries.length,
    entityCount: normalized.entities.length,
    lowConfidenceThreshold: Number.isFinite(args.lowConfidenceThreshold) ? args.lowConfidenceThreshold : 0.55,
    fuzzyThreshold: Number.isFinite(args.fuzzyThreshold) ? args.fuzzyThreshold : 0.94,
  },
  entities: normalized.entities,
  noteEntities: normalized.noteEntities,
  review: normalized.review,
};

await writeJsonFile(outputFile, output);

console.log(`[entity-lab] normalized entities written: ${outputFile}`);
console.log(`[entity-lab] entity count: ${output.entities.length}`);
console.log(`[entity-lab] note count: ${output.metadata.noteCount}`);
console.log(`[entity-lab] low-confidence mentions: ${output.review.lowConfidenceMentions.length}`);
console.log(`[entity-lab] risky merges: ${output.review.riskyMerges.length}`);
console.log(`[entity-lab] near duplicates: ${output.review.nearDuplicates.length}`);

function parseArgs(argv) {
  const out = {
    notesDir: '',
    cacheFile: '',
    output: '',
    fuzzyThreshold: Number.NaN,
    lowConfidenceThreshold: Number.NaN,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--notes-dir') {
      out.notesDir = argv[++i] ?? '';
      continue;
    }
    if (arg === '--cache-file') {
      out.cacheFile = argv[++i] ?? '';
      continue;
    }
    if (arg === '--output') {
      out.output = argv[++i] ?? '';
      continue;
    }
    if (arg === '--fuzzy-threshold') {
      out.fuzzyThreshold = Number(argv[++i] ?? '0');
      continue;
    }
    if (arg === '--low-confidence-threshold') {
      out.lowConfidenceThreshold = Number(argv[++i] ?? '0');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node experiments/entity-lab/scripts/normalize-entities.mjs --notes-dir <path> [options]

Options:
  --notes-dir <path>                  Required. Root notes directory.
  --cache-file <path>                 Cache file path.
  --output <path>                     Output JSON path (default: experiments/entity-lab/reports/entities.json).
  --fuzzy-threshold <number>          Fuzzy merge threshold (default: 0.94).
  --low-confidence-threshold <number> Low confidence review threshold (default: 0.55).
  --help, -h                          Show help.
`);
}
