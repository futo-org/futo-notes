#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { REPORTS_DIR } from './lib/constants.mjs';
import { ensureDir, readJsonFile } from './lib/fs-utils.mjs';
import { noteDisplayLabel } from './lib/entity-normalization.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const inputPath = path.resolve(args.input || path.join(REPORTS_DIR, 'entities.json'));
const outputDir = path.resolve(args.outputDir || REPORTS_DIR);

await ensureDir(outputDir);

const artifact = await readJsonFile(inputPath);
if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.entities)) {
  throw new Error(`Invalid normalized artifact: ${inputPath}`);
}

const grouped = new Map();
for (const entity of artifact.entities) {
  if (!grouped.has(entity.type)) grouped.set(entity.type, []);
  grouped.get(entity.type).push(entity);
}

for (const entities of grouped.values()) {
  entities.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    return a.name.localeCompare(b.name);
  });
}

const typeFiles = [
  { type: 'project', file: 'projects.md', title: 'Projects' },
  { type: 'person', file: 'people.md', title: 'People' },
  { type: 'organization', file: 'organizations.md', title: 'Organizations' },
  { type: 'tool', file: 'tools.md', title: 'Tools' },
  { type: 'place', file: 'places.md', title: 'Places' },
];

for (const target of typeFiles) {
  const entities = grouped.get(target.type) ?? [];
  const body = renderTypeReport(target.title, entities);
  await writeTextFile(path.join(outputDir, target.file), body);
}

const indexBody = renderIndex({
  artifact,
  typeFiles,
  grouped,
});
await writeTextFile(path.join(outputDir, 'index.md'), indexBody);

console.log(`[entity-lab] reports generated in ${outputDir}`);

function renderTypeReport(title, entities) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Total entities: ${entities.length}`);
  lines.push('');

  if (entities.length === 0) {
    lines.push('_No entities found._');
    lines.push('');
    return lines.join('\n');
  }

  for (const entity of entities) {
    lines.push(`## ${entity.name} (${entity.noteCount} notes)`);

    if (Array.isArray(entity.aliases) && entity.aliases.length > 0) {
      lines.push(`Aliases: ${entity.aliases.join(', ')}`);
    }

    lines.push(`Mentions: ${entity.mentionCount} | Avg confidence: ${formatConfidence(entity.avgConfidence)}`);

    for (const note of entity.notes) {
      const noteLabel = noteDisplayLabel(note);
      const relPath = toDisplayPath(note.noteId);
      const confidence = note.mentions.length
        ? note.mentions.reduce((sum, mention) => sum + mention.confidence, 0) / note.mentions.length
        : 0;
      lines.push(`- ${noteLabel} (${relPath}) [conf ${formatConfidence(confidence)}]`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function renderIndex({ artifact, typeFiles, grouped }) {
  const lines = [];

  lines.push('# Entity Lab Reports');
  lines.push('');
  lines.push(`Generated: ${artifact.metadata?.generatedAt ?? 'unknown'}`);
  lines.push(`Notes directory: ${artifact.metadata?.notesDir ?? 'unknown'}`);
  lines.push(`Notes analyzed: ${artifact.metadata?.noteCount ?? 0}`);
  lines.push(`Entities: ${artifact.metadata?.entityCount ?? artifact.entities.length}`);
  lines.push('');
  lines.push('## Groups');
  lines.push('');

  for (const target of typeFiles) {
    const count = (grouped.get(target.type) ?? []).length;
    lines.push(`- [${target.title}](./${target.file}) (${count})`);
  }

  lines.push('');
  lines.push('## Review Queue');
  lines.push('');
  lines.push('- [review-queue.md](./review-queue.md)');
  lines.push('');

  return lines.join('\n');
}

function toDisplayPath(noteId) {
  return noteId.split(path.sep).join('/');
}

function formatConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.00';
  return numeric.toFixed(2);
}

async function writeTextFile(filePath, content) {
  await fs.writeFile(filePath, content + '\n', 'utf8');
}

function parseArgs(argv) {
  const out = {
    input: '',
    outputDir: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--input') {
      out.input = argv[++i] ?? '';
      continue;
    }
    if (arg === '--output-dir') {
      out.outputDir = argv[++i] ?? '';
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
  node experiments/entity-lab/scripts/build-reports.mjs [options]

Options:
  --input <path>      Normalized artifact JSON (default: experiments/entity-lab/reports/entities.json)
  --output-dir <path> Output report directory (default: experiments/entity-lab/reports)
  --help, -h          Show help
`);
}
