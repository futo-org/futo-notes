#!/usr/bin/env node

/**
 * Phase 3: Assign tags from the hierarchical taxonomy to each note.
 * Uses the fixed category/tag list — the LLM cannot invent new ones.
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
import { createProgressLogger } from './lib/progress.mjs';

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
const maxNoteChars = args.maxNoteChars > 0 ? args.maxNoteChars : 4000;
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

if (!taxonomy?.categories?.length) {
  console.error('[tag-assign] No taxonomy found. Run tag-consolidate first.');
  process.exit(1);
}

// Build allowed sets and taxonomy string for prompt
const allowedCategories = new Set(taxonomy.categories.map(c => c.category));
const allowedTagsByCategory = new Map();
for (const cat of taxonomy.categories) {
  const tagSet = new Set(cat.tags.map(t => t.tag));
  allowedTagsByCategory.set(cat.category, tagSet);
}

const taxonomyStr = taxonomy.categories.map(cat => {
  const tags = cat.tags.map(t => t.tag).join(', ');
  return `${cat.category}: ${tags}`;
}).join('\n');

if (!args.mock) {
  await verifyConnection({ backend, host, model });
}

const callLlm = createLlmClient({ backend, host, model });

const files = await listMarkdownFiles(notesDir);
if (files.length === 0) throw new Error(`No markdown files found in ${notesDir}`);

const cache = (await readJsonFile(assignCachePath)) ?? { version: 2, notes: {} };

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

const totalTaxonomyTags = taxonomy.categories.reduce((sum, c) => sum + c.tags.length, 0);
console.log(`[tag-assign] taxonomy: ${taxonomy.categories.length} categories, ${totalTaxonomyTags} tags`);
console.log(`[tag-assign] notes found: ${noteRecords.length}`);
console.log(`[tag-assign] notes to process: ${toProcess.length}`);
console.log(`[tag-assign] skipped unchanged: ${skipped.length}`);
console.log(`[tag-assign] mode: ${args.mock ? 'mock' : backend}${args.mock && args.vllm ? ' (vllm)' : ''} | model: ${model} | concurrency: ${concurrency}`);

let failed = 0;
let completed = 0;
const flusher = createCacheFlusher(cache, assignCachePath);
const progress = createProgressLogger('tag-assign', toProcess.length);

await runConcurrent(toProcess, async (note) => {
  const started = performance.now();

  try {
    const promptWithTaxonomy = promptTemplate.replace('{{TAXONOMY}}', taxonomyStr);
    const prompt = buildUserPrompt(promptWithTaxonomy, note.title, note.content);

    const rawPayload = args.mock
      ? mockAssign(note)
      : await callLlm({
          messages: [
            { role: 'system', content: 'Assign a category and tags to notes from a fixed taxonomy. Respond with valid JSON only.' },
            { role: 'user', content: prompt },
          ],
          schema,
          think: args.think,
          temperature: 0.1,
        });

    const parsed = parseModelJson(rawPayload);
    const { category, tags } = sanitizeResult(parsed, allowedCategories, allowedTagsByCategory);
    const durationMs = Math.round(performance.now() - started);

    cache.notes[note.noteId] = {
      title: note.title,
      hash: note.hash,
      model,
      category,
      tags,
      assignedAt: new Date().toISOString(),
    };

    completed++;
    const label = category ? `${category}/${tags.join(', ')}` : tags.join(', ');
    console.log(`[tag-assign] ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) -> [${label}]`);
    flusher.tick();
    progress.tick();
  } catch (error) {
    failed++;
    const durationMs = Math.round(performance.now() - started);
    console.error(`[tag-assign] FAIL ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) ${error.message}`);
    flusher.tick();
    progress.tick();
  }
}, concurrency);

await flusher.flush();

// Build report — grouped by category
const catGroups = new Map();
for (const cat of taxonomy.categories) {
  catGroups.set(cat.category, { tags: new Map(), uncategorized: [] });
  for (const t of cat.tags) {
    catGroups.get(cat.category).tags.set(t.tag, []);
  }
}

let untaggedCount = 0;
for (const [noteId, entry] of Object.entries(cache.notes)) {
  const cat = entry.category || '';
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  if (!cat && tags.length === 0) { untaggedCount++; continue; }

  if (catGroups.has(cat)) {
    const group = catGroups.get(cat);
    for (const tag of tags) {
      if (group.tags.has(tag)) {
        group.tags.get(tag).push({ noteId, title: entry.title });
      }
    }
  }
}

// Write JSON report
const assignments = {
  generatedAt: new Date().toISOString(),
  notesDir,
  totalNotes: Object.keys(cache.notes).length,
  untagged: untaggedCount,
  categories: taxonomy.categories.map(cat => {
    const group = catGroups.get(cat.category);
    const tags = [...group.tags.entries()]
      .map(([tag, notes]) => ({ tag, count: notes.length, notes: notes.map(n => n.noteId) }))
      .sort((a, b) => b.count - a.count);
    return { category: cat.category, tags };
  }),
};
await writeJsonFile(path.join(REPORTS_DIR, 'tag-assignments.json'), assignments);

// Write markdown report
const lines = [
  '# Tags Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Notes: ${assignments.totalNotes} | Untagged: ${untaggedCount}`,
  `Categories: ${assignments.categories.length}`,
  '',
];

for (const cat of assignments.categories) {
  const catNoteCount = cat.tags.reduce((sum, t) => sum + t.count, 0);
  if (catNoteCount === 0) continue;
  lines.push(`# ${cat.category} (${catNoteCount} notes)`);
  lines.push('');

  for (const { tag, count, notes } of cat.tags) {
    if (count === 0) continue;
    lines.push(`## ${cat.category}/${tag} (${count} notes)`);
    lines.push('');
    for (const noteId of notes) {
      const entry = cache.notes[noteId];
      lines.push(`- ${entry?.title || noteId}`);
    }
    lines.push('');
  }
}

if (untaggedCount > 0) {
  lines.push(`# Untagged (${untaggedCount} notes)`);
  lines.push('');
  for (const [noteId, entry] of Object.entries(cache.notes)) {
    if ((!entry.category) && (!entry.tags || entry.tags.length === 0)) {
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

function sanitizeResult(parsed, allowedCats, allowedTagsByCat) {
  let category = typeof parsed?.category === 'string'
    ? parsed.category.trim().toLowerCase().replace(/\s+/g, '-')
    : '';

  // Snap to allowed category
  if (category && !allowedCats.has(category)) {
    category = '';
  }

  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : [];
  const allowedTags = category ? (allowedTagsByCat.get(category) || new Set()) : new Set();

  const tags = rawTags
    .map(t => (typeof t === 'string' ? t.trim().toLowerCase().replace(/\s+/g, '-') : ''))
    .filter(t => allowedTags.has(t))
    .slice(0, 3);

  return { category, tags };
}

function mockAssign(note) {
  const lower = note.content.toLowerCase();
  if (/software|code|api/.test(lower)) return { category: 'technology', tags: ['software-dev'] };
  if (/journal|morning|evening/.test(lower)) return { category: 'personal', tags: ['journal'] };
  return { category: '', tags: [] };
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
