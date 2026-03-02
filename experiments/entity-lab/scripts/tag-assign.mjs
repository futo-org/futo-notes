#!/usr/bin/env node

/**
 * Phase 3: Assign tags from the canonical taxonomy to each note.
 * Uses the fixed tag list — the LLM cannot invent new tags.
 * Writes final assignments to reports/tag-assignments.json and reports/tags-report.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CACHE_DIR,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_VLLM_HOST,
  PROMPTS_DIR,
  REPORTS_DIR,
  SCHEMAS_DIR,
} from './lib/constants.mjs';
import { ensureDir, listMarkdownFiles, readJsonFile, writeJsonFile } from './lib/fs-utils.mjs';
import { sha256 } from './lib/hash.mjs';
import { buildUserPrompt, parseModelJson } from './lib/extraction-schema.mjs';
import { createLlmClient, verifyConnection } from './lib/llm.mjs';
import { runConcurrent } from './lib/concurrency.mjs';
import { createCacheFlusher } from './lib/cache-flusher.mjs';

const args = parseArgs(process.argv.slice(2));

if (!args.notesDir) {
  console.error('Missing required argument: --notes-dir <path>');
  process.exit(1);
}

const notesDir = path.resolve(args.notesDir);
const backend = args.vllm ? 'vllm' : 'ollama';
const defaultHost = backend === 'vllm' ? DEFAULT_VLLM_HOST : DEFAULT_OLLAMA_HOST;
const host = (args.vllmHost || args.ollamaHost || process.env.OLLAMA_HOST || defaultHost).replace(/\/+$/, '');
const model = args.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
const maxNoteChars = args.maxNoteChars > 0 ? args.maxNoteChars : 12000;
const concurrency = args.concurrency > 0 ? args.concurrency : 1;

const taxonomyPath = path.resolve(args.taxonomyFile || path.join(CACHE_DIR, 'tag-taxonomy.json'));
const assignCachePath = path.resolve(args.cacheFile || path.join(CACHE_DIR, 'tag-assign.json'));

const promptPath = path.join(PROMPTS_DIR, 'tag-assign.md');
const schemaPath = path.join(SCHEMAS_DIR, 'tag-assign.schema.json');

await ensureDir(CACHE_DIR);
await ensureDir(REPORTS_DIR);

const [promptTemplate, schema, taxonomy] = await Promise.all([
  fs.readFile(promptPath, 'utf8'),
  readJsonFile(schemaPath),
  readJsonFile(taxonomyPath),
]);

if (!taxonomy?.tags?.length) {
  console.error('[tag-assign] No taxonomy found. Run tag-consolidate first.');
  process.exit(1);
}

const allowedTags = new Set(taxonomy.tags.map(t => t.tag));
const tagListStr = taxonomy.tags.map(t => `- ${t.tag}`).join('\n');

if (!args.mock) {
  await verifyConnection({ backend, host, model });
}

const callLlm = createLlmClient({ backend, host, model });

const files = await listMarkdownFiles(notesDir);
if (files.length === 0) throw new Error(`No markdown files found in ${notesDir}`);

const cache = (await readJsonFile(assignCachePath)) ?? { version: 1, notes: {} };

const noteRecords = await loadNoteRecords(files, notesDir, maxNoteChars);
if (args.maxNotes && args.maxNotes > 0) noteRecords.splice(args.maxNotes);

const toProcess = [];
const skipped = [];
for (const note of noteRecords) {
  const cached = cache.notes[note.noteId];
  const unchanged = !args.force && cached && cached.hash === note.hash && cached.model === model;
  if (unchanged) { skipped.push(note.noteId); continue; }
  toProcess.push(note);
}

console.log(`[tag-assign] taxonomy: ${allowedTags.size} tags`);
console.log(`[tag-assign] notes found: ${noteRecords.length}`);
console.log(`[tag-assign] notes to process: ${toProcess.length}`);
console.log(`[tag-assign] skipped unchanged: ${skipped.length}`);
console.log(`[tag-assign] mode: ${args.mock ? 'mock' : backend}${args.mock && args.vllm ? ' (vllm)' : ''} | model: ${model} | concurrency: ${concurrency}`);

let failed = 0;
let completed = 0;
const flusher = createCacheFlusher(cache, assignCachePath);

await runConcurrent(toProcess, async (note) => {
  const started = performance.now();

  try {
    const promptWithTags = promptTemplate.replace('{{TAG_LIST}}', tagListStr);
    const prompt = buildUserPrompt(promptWithTags, note.title, note.content);

    const rawPayload = args.mock
      ? mockAssign(note, allowedTags)
      : await callLlm({
          messages: [
            { role: 'system', content: 'Assign tags to notes from a fixed list. Respond with valid JSON only (after any thinking).' },
            { role: 'user', content: prompt },
          ],
          schema,
          think: args.think,
          temperature: 0.1,
        });

    const parsed = parseModelJson(rawPayload);
    const tags = sanitizeTags(parsed, allowedTags);
    const durationMs = Math.round(performance.now() - started);

    cache.notes[note.noteId] = {
      title: note.title,
      hash: note.hash,
      model,
      tags,
      assignedAt: new Date().toISOString(),
    };

    completed++;
    console.log(`[tag-assign] ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) -> [${tags.join(', ')}]`);
    flusher.tick();
  } catch (error) {
    failed++;
    const durationMs = Math.round(performance.now() - started);
    console.error(`[tag-assign] FAIL ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) ${error.message}`);
    flusher.tick();
  }
}, concurrency);

await flusher.flush();

// Build report
const tagGroups = new Map();
for (const tagEntry of taxonomy.tags) {
  tagGroups.set(tagEntry.tag, []);
}

let untaggedCount = 0;
for (const [noteId, entry] of Object.entries(cache.notes)) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  if (tags.length === 0) { untaggedCount++; continue; }
  for (const tag of tags) {
    if (tagGroups.has(tag)) {
      tagGroups.get(tag).push({ noteId, title: entry.title });
    }
  }
}

// Write JSON report
const assignments = {
  generatedAt: new Date().toISOString(),
  notesDir,
  totalNotes: Object.keys(cache.notes).length,
  untagged: untaggedCount,
  tags: [...tagGroups.entries()]
    .map(([tag, notes]) => ({ tag, count: notes.length, notes: notes.map(n => n.noteId) }))
    .sort((a, b) => b.count - a.count),
};
await writeJsonFile(path.join(REPORTS_DIR, 'tag-assignments.json'), assignments);

// Write markdown report
const lines = [
  '# Tags Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Notes: ${assignments.totalNotes} | Untagged: ${untaggedCount}`,
  `Tags: ${assignments.tags.filter(t => t.count > 0).length}`,
  '',
];

for (const { tag, count, notes } of assignments.tags) {
  if (count === 0) continue;
  lines.push(`## ${tag} (${count} notes)`);
  lines.push('');
  for (const noteId of notes) {
    const entry = cache.notes[noteId];
    const title = entry?.title || noteId;
    lines.push(`- ${title}`);
  }
  lines.push('');
}

if (untaggedCount > 0) {
  lines.push(`## Untagged (${untaggedCount} notes)`);
  lines.push('');
  for (const [noteId, entry] of Object.entries(cache.notes)) {
    if (!entry.tags || entry.tags.length === 0) {
      lines.push(`- ${entry.title || noteId}`);
    }
  }
  lines.push('');
}

await fs.writeFile(path.join(REPORTS_DIR, 'tags-report.md'), lines.join('\n'), 'utf8');

console.log(`[tag-assign] done. ${completed} succeeded, ${failed} failed.`);
console.log(`[tag-assign] report: ${path.join(REPORTS_DIR, 'tags-report.md')}`);
if (failed > 0) process.exitCode = 2;

// --- helpers ---

function sanitizeTags(parsed, allowed) {
  const raw = Array.isArray(parsed?.tags) ? parsed.tags : [];
  return raw
    .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter(t => allowed.has(t))
    .slice(0, 3);
}

function mockAssign(note, allowed) {
  const tags = [];
  const lower = note.content.toLowerCase();
  for (const tag of allowed) {
    if (lower.includes(tag)) tags.push(tag);
    if (tags.length >= 2) break;
  }
  return { tags };
}

async function loadNoteRecords(files, notesDir, maxChars) {
  const records = [];
  for (const sourcePath of files) {
    const [contentRaw, stat] = await Promise.all([
      fs.readFile(sourcePath, 'utf8'),
      fs.stat(sourcePath),
    ]);
    const relative = path.relative(notesDir, sourcePath).split(path.sep).join('/');
    const content = maxChars > 0 ? contentRaw.slice(0, maxChars) : contentRaw;
    const title = path.basename(sourcePath).replace(/\.md$/i, '');
    records.push({ noteId: relative, sourcePath, title, content, hash: sha256(contentRaw), mtimeMs: stat.mtimeMs });
  }
  return records;
}

function parseArgs(argv) {
  const out = {
    notesDir: '', cacheFile: '', taxonomyFile: '', model: '', ollamaHost: '', vllmHost: '',
    force: false, maxNotes: 0, maxNoteChars: 0, mock: false, think: false,
    vllm: false, concurrency: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--notes-dir') { out.notesDir = argv[++i] ?? ''; continue; }
    if (arg === '--cache-file') { out.cacheFile = argv[++i] ?? ''; continue; }
    if (arg === '--taxonomy-file') { out.taxonomyFile = argv[++i] ?? ''; continue; }
    if (arg === '--model') { out.model = argv[++i] ?? ''; continue; }
    if (arg === '--ollama-host') { out.ollamaHost = argv[++i] ?? ''; continue; }
    if (arg === '--vllm-host') { out.vllmHost = argv[++i] ?? ''; continue; }
    if (arg === '--max-notes') { out.maxNotes = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--max-note-chars') { out.maxNoteChars = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--concurrency') { out.concurrency = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--force') { out.force = true; continue; }
    if (arg === '--mock') { out.mock = true; continue; }
    if (arg === '--think') { out.think = true; continue; }
    if (arg === '--vllm') { out.vllm = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
