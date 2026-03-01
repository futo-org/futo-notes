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
  PROMPTS_DIR,
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
const cacheFilePath = path.resolve(args.cacheFile || path.join(CACHE_DIR, 'tag-discover.json'));

const promptPath = path.join(PROMPTS_DIR, 'tag-discover.md');
const schemaPath = path.join(SCHEMAS_DIR, 'tag-discover.schema.json');

await ensureDir(CACHE_DIR);

const [promptTemplate, schema] = await Promise.all([
  fs.readFile(promptPath, 'utf8'),
  readJsonFile(schemaPath),
]);

if (!args.mock) {
  await verifyOllamaConnection({ ollamaHost, model });
}

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
console.log(`[tag-discover] mode: ${args.mock ? 'mock' : 'ollama'} | model: ${model}`);

let failed = 0;
for (let i = 0; i < toProcess.length; i++) {
  const note = toProcess[i];
  const started = performance.now();

  try {
    const prompt = buildUserPrompt(promptTemplate, note.title, note.content);
    const rawPayload = args.mock
      ? mockDiscover(note)
      : await callOllama({ ollamaHost, model, schema, prompt, think: args.think });

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

    console.log(`[tag-discover] ${i + 1}/${toProcess.length}: ${note.noteId} (${durationMs}ms) -> [${tags.join(', ')}]`);
  } catch (error) {
    failed++;
    const durationMs = Math.round(performance.now() - started);
    console.error(`[tag-discover] FAIL ${i + 1}/${toProcess.length}: ${note.noteId} (${durationMs}ms) ${error.message}`);
  }
}

cache.updatedAt = new Date().toISOString();
await writeJsonFile(cacheFilePath, cache);

console.log(`[tag-discover] done. ${toProcess.length - failed} succeeded, ${failed} failed.`);
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

async function callOllama({ ollamaHost, model, schema, prompt, think }) {
  const body = {
    model,
    stream: false,
    options: { temperature: 0.3 },
    messages: [
      { role: 'system', content: 'Tag personal notes with broad topic categories. Respond with valid JSON only (after any thinking).' },
      { role: 'user', content: prompt },
    ],
  };

  // When thinking is enabled, don't constrain format so <think> tags can flow.
  // When disabled, use strict JSON schema.
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
  const hasModel = models.some(m => m?.name === model || m?.model === model);
  if (!hasModel) throw new Error(`Model not found: ${model}. Run: ollama pull ${model}`);
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
  const out = { notesDir: '', cacheFile: '', model: '', ollamaHost: '', force: false, maxNotes: 0, maxNoteChars: 0, mock: false, think: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--notes-dir') { out.notesDir = argv[++i] ?? ''; continue; }
    if (arg === '--cache-file') { out.cacheFile = argv[++i] ?? ''; continue; }
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
