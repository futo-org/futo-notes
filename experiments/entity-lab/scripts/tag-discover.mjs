#!/usr/bin/env node

/**
 * Pass 1: Free-form tag discovery.
 * Asks the LLM for 1-3 broad topic tags per note with no constraints.
 * Writes raw tags to cache/tag-discover.json
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
  SCHEMAS_DIR,
} from './lib/constants.mjs';
import { ensureDir, listMarkdownFiles, readJsonFile } from './lib/fs-utils.mjs';
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
const maxNoteChars = args.maxNoteChars > 0 ? args.maxNoteChars : 12000;
const concurrency = args.concurrency > 0 ? args.concurrency : 1;
const cacheFilePath = path.resolve(args.cacheFile || path.join(CACHE_DIR, 'tag-discover.json'));

const promptPath = path.join(PROMPTS_DIR, 'tag-discover.md');
const schemaPath = path.join(SCHEMAS_DIR, 'tag-discover.schema.json');

await ensureDir(CACHE_DIR);

const [promptTemplate, schema] = await Promise.all([
  fs.readFile(promptPath, 'utf8'),
  readJsonFile(schemaPath),
]);

if (!args.mock) {
  await verifyConnection({ backend, host, model });
}

const callLlm = createLlmClient({ backend, host, model });

const files = await listMarkdownFiles(notesDir);
if (files.length === 0) {
  throw new Error(`No markdown files found in ${notesDir}`);
}

const cache = (await readJsonFile(cacheFilePath)) ?? { version: 1, notes: {} };

const noteRecords = await loadNoteRecords(files, notesDir, maxNoteChars);
if (args.maxNotes && args.maxNotes > 0) {
  noteRecords.splice(args.maxNotes);
}

const toProcess = [];
const skipped = [];
for (const note of noteRecords) {
  const cached = cache.notes[note.noteId];
  const unchanged = !args.force && cached && cached.hash === note.hash && cached.model === model;
  if (unchanged) {
    skipped.push(note.noteId);
    continue;
  }
  toProcess.push(note);
}

console.log(`[tag-discover] notes found: ${noteRecords.length}`);
console.log(`[tag-discover] notes to process: ${toProcess.length}`);
console.log(`[tag-discover] skipped unchanged: ${skipped.length}`);
console.log(`[tag-discover] mode: ${args.mock ? 'mock' : backend}${args.mock && args.vllm ? ' (vllm)' : ''} | model: ${model} | concurrency: ${concurrency}`);

let failed = 0;
let completed = 0;
const flusher = createCacheFlusher(cache, cacheFilePath);
const progress = createProgressLogger('tag-discover', toProcess.length);

await runConcurrent(toProcess, async (note) => {
  const started = performance.now();

  try {
    const prompt = buildUserPrompt(promptTemplate, note.title, note.content);
    const rawPayload = args.mock
      ? mockDiscover(note)
      : await callLlm({
          messages: [
            { role: 'system', content: 'Tag personal notes with broad topic categories. Respond with valid JSON only (after any thinking).' },
            { role: 'user', content: prompt },
          ],
          schema,
          think: args.think,
          temperature: 0.3,
        });

    const parsed = parseModelJson(rawPayload);
    const tags = sanitizeTags(parsed);
    const durationMs = Math.round(performance.now() - started);

    cache.notes[note.noteId] = {
      title: note.title,
      hash: note.hash,
      model,
      tags,
      discoveredAt: new Date().toISOString(),
    };

    completed++;
    console.log(`[tag-discover] ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) -> [${tags.join(', ')}]`);
    flusher.tick();
    progress.tick();
  } catch (error) {
    failed++;
    const durationMs = Math.round(performance.now() - started);
    console.error(`[tag-discover] FAIL ${completed + failed}/${toProcess.length}: ${note.noteId} (${durationMs}ms) ${error.message}`);
    flusher.tick();
    progress.tick();
  }
}, concurrency);

await flusher.flush();

console.log(`[tag-discover] done. ${completed} succeeded, ${failed} failed.`);
if (failed > 0) process.exitCode = 2;

// --- helpers ---

function sanitizeTags(parsed) {
  const raw = Array.isArray(parsed?.tags) ? parsed.tags : [];
  return raw
    .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter(t => t.length > 0 && t.length <= 60)
    .slice(0, 3);
}

function mockDiscover(note) {
  const tags = [];
  const lower = note.content.toLowerCase();
  if (/software|code|program|app|api|function/.test(lower)) tags.push('software');
  if (/journal|diary|today|morning|evening|day/.test(lower)) tags.push('journaling');
  if (/idea|brainstorm|concept/.test(lower)) tags.push('ideas');
  if (/workout|exercise|gym|fitness|run|lift/.test(lower)) tags.push('fitness');
  if (tags.length === 0) tags.push('misc');
  return { tags: tags.slice(0, 3) };
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
    notesDir: '', cacheFile: '', model: '', ollamaHost: '', vllmHost: '',
    force: false, maxNotes: 0, maxNoteChars: 0, mock: false, think: false,
    vllm: false, concurrency: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--notes-dir') { out.notesDir = argv[++i] ?? ''; continue; }
    if (arg === '--cache-file') { out.cacheFile = argv[++i] ?? ''; continue; }
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
