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
  PROMPTS_DIR,
  REPORTS_DIR,
  SCHEMAS_DIR,
} from './lib/constants.mjs';
import { ensureDir, listMarkdownFiles, readJsonFile, writeJsonFile } from './lib/fs-utils.mjs';
import { sha256 } from './lib/hash.mjs';
import { buildUserPrompt, parseModelJson } from './lib/extraction-schema.mjs';

const args = parseArgs(process.argv.slice(2));

if (!args.notesDir) {
  console.error('Missing required argument: --notes-dir <path>');
  process.exit(1);
}

const notesDir = path.resolve(args.notesDir);
const ollamaHost = (args.ollamaHost || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
const model = args.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
const maxNoteChars = args.maxNoteChars > 0 ? args.maxNoteChars : 12000;

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
  await verifyOllamaConnection({ ollamaHost, model });
}

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
console.log(`[tag-assign] mode: ${args.mock ? 'mock' : 'ollama'} | model: ${model}`);

let failed = 0;
for (let i = 0; i < toProcess.length; i++) {
  const note = toProcess[i];
  const started = performance.now();

  try {
    // Inject the tag list into the prompt template
    const promptWithTags = promptTemplate.replace('{{TAG_LIST}}', tagListStr);
    const prompt = buildUserPrompt(promptWithTags, note.title, note.content);

    const rawPayload = args.mock
      ? mockAssign(note, allowedTags)
      : await callOllama({ ollamaHost, model, schema, prompt, think: args.think });

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

    console.log(`[tag-assign] ${i + 1}/${toProcess.length}: ${note.noteId} (${durationMs}ms) -> [${tags.join(', ')}]`);
  } catch (error) {
    failed++;
    const durationMs = Math.round(performance.now() - started);
    console.error(`[tag-assign] FAIL ${i + 1}/${toProcess.length}: ${note.noteId} (${durationMs}ms) ${error.message}`);
  }
}

cache.updatedAt = new Date().toISOString();
await writeJsonFile(assignCachePath, cache);

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

console.log(`[tag-assign] done. ${toProcess.length - failed} succeeded, ${failed} failed.`);
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

async function callOllama({ ollamaHost, model, schema, prompt, think }) {
  const body = {
    model,
    stream: false,
    options: { temperature: 0.1 },
    messages: [
      { role: 'system', content: 'Assign tags to notes from a fixed list. Respond with valid JSON only (after any thinking).' },
      { role: 'user', content: prompt },
    ],
  };

  if (!think) {
    body.format = schema;
  }

  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = await response.json();
  if (!payload?.message) throw new Error('Ollama response missing message payload');

  let content = payload.message.content;
  if (think) {
    content = stripThinkTags(content);
  }
  return content;
}

function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function verifyOllamaConnection({ ollamaHost, model }) {
  const response = await fetch(`${ollamaHost}/api/tags`);
  if (!response.ok) throw new Error(`Ollama /api/tags failed (${response.status})`);
  const payload = await response.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  if (!models.some(m => m?.name === model || m?.model === model))
    throw new Error(`Model not found: ${model}. Run: ollama pull ${model}`);
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
  const out = { notesDir: '', cacheFile: '', taxonomyFile: '', model: '', ollamaHost: '', force: false, maxNotes: 0, maxNoteChars: 0, mock: false, think: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--notes-dir') { out.notesDir = argv[++i] ?? ''; continue; }
    if (arg === '--cache-file') { out.cacheFile = argv[++i] ?? ''; continue; }
    if (arg === '--taxonomy-file') { out.taxonomyFile = argv[++i] ?? ''; continue; }
    if (arg === '--model') { out.model = argv[++i] ?? ''; continue; }
    if (arg === '--ollama-host') { out.ollamaHost = argv[++i] ?? ''; continue; }
    if (arg === '--max-notes') { out.maxNotes = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--max-note-chars') { out.maxNoteChars = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--force') { out.force = true; continue; }
    if (arg === '--mock') { out.mock = true; continue; }
    if (arg === '--think') { out.think = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
