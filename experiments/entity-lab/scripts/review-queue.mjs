#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { REPORTS_DIR } from './lib/constants.mjs';
import { ensureDir, readJsonFile } from './lib/fs-utils.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const inputPath = path.resolve(args.input || path.join(REPORTS_DIR, 'entities.json'));
const outputPath = path.resolve(args.output || path.join(REPORTS_DIR, 'review-queue.md'));

await ensureDir(path.dirname(outputPath));

const artifact = await readJsonFile(inputPath);
if (!artifact || typeof artifact !== 'object' || !artifact.review) {
  throw new Error(`Invalid normalized artifact for review queue: ${inputPath}`);
}

const low = Array.isArray(artifact.review.lowConfidenceMentions) ? artifact.review.lowConfidenceMentions : [];
const risky = Array.isArray(artifact.review.riskyMerges) ? artifact.review.riskyMerges : [];
const nearDupes = Array.isArray(artifact.review.nearDuplicates) ? artifact.review.nearDuplicates : [];

const lines = [];
lines.push('# Entity Review Queue');
lines.push('');
lines.push(`Generated: ${artifact.metadata?.generatedAt ?? 'unknown'}`);
lines.push('');

lines.push('## Low Confidence Mentions');
lines.push('');
if (low.length === 0) {
  lines.push('_None_');
  lines.push('');
} else {
  const sorted = [...low].sort((a, b) => a.confidence - b.confidence).slice(0, 500);
  for (const item of sorted) {
    lines.push(`- [${item.type}] ${item.rawName} -> ${item.canonicalName} | ${item.noteId} | conf ${Number(item.confidence).toFixed(2)}`);
    if (Array.isArray(item.evidence) && item.evidence.length > 0) {
      lines.push(`  evidence: ${item.evidence[0]}`);
    }
  }
  lines.push('');
}

lines.push('## Risky Merges');
lines.push('');
if (risky.length === 0) {
  lines.push('_None_');
  lines.push('');
} else {
  for (const item of risky.slice(0, 200)) {
    lines.push(`- [${item.type}] ${item.name} (${item.noteCount} notes)`);
    lines.push(`  merge methods: ${(item.mergeMethods ?? []).join(', ')}`);
    if (Array.isArray(item.aliases) && item.aliases.length > 0) {
      lines.push(`  aliases: ${item.aliases.slice(0, 10).join(', ')}`);
    }
    const evidence = Array.isArray(item.mergeEvidence) ? item.mergeEvidence.slice(0, 3) : [];
    for (const ev of evidence) {
      lines.push(`  fuzzy merge: ${ev.from} -> ${ev.to} (score ${Number(ev.score ?? 0).toFixed(2)}) in ${ev.noteId}`);
    }
  }
  lines.push('');
}

lines.push('## Near-Duplicate Candidates');
lines.push('');
if (nearDupes.length === 0) {
  lines.push('_None_');
  lines.push('');
} else {
  for (const item of nearDupes.slice(0, 300)) {
    lines.push(`- [${item.type}] ${item.entityA.name} <-> ${item.entityB.name} (score ${Number(item.score).toFixed(2)})`);
  }
  lines.push('');
}

await fs.writeFile(outputPath, lines.join('\n') + '\n', 'utf8');
console.log(`[entity-lab] review queue written: ${outputPath}`);

function parseArgs(argv) {
  const out = {
    input: '',
    output: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--input') {
      out.input = argv[++i] ?? '';
      continue;
    }
    if (arg === '--output') {
      out.output = argv[++i] ?? '';
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
  node experiments/entity-lab/scripts/review-queue.mjs [options]

Options:
  --input <path>   Normalized artifact JSON (default: experiments/entity-lab/reports/entities.json)
  --output <path>  Review report path (default: experiments/entity-lab/reports/review-queue.md)
  --help, -h       Show help
`);
}
