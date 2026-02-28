#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CACHE_DIR,
  CACHE_VERSION,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_HOST,
  PROMPTS_DIR,
  PROMPT_VERSION,
  REPORTS_DIR,
  RUNS_DIR,
  SCHEMAS_DIR,
  SCHEMA_VERSION,
  makeTimestampSlug,
} from './lib/constants.mjs';
import { ensureDir, getNoteTitleFromPath, listMarkdownFiles, readJsonFile, toPosixPath, writeJsonFile } from './lib/fs-utils.mjs';
import { sha256 } from './lib/hash.mjs';
import { buildUserPrompt, parseModelJson, sanitizeExtraction } from './lib/extraction-schema.mjs';

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
const ollamaHost = (args.ollamaHost || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
const model = args.model || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
const maxNoteChars = args.maxNoteChars > 0 ? args.maxNoteChars : 12000;

const cacheFilePath = path.resolve(args.cacheFile || path.join(CACHE_DIR, 'extractions-cache.json'));
const runId = makeTimestampSlug();
const runDir = path.resolve(args.outputDir || path.join(RUNS_DIR, runId));
const runStartedAt = new Date().toISOString();

const promptPath = path.resolve(args.promptFile || path.join(PROMPTS_DIR, 'entity-extract.md'));
const schemaPath = path.resolve(args.schemaFile || path.join(SCHEMAS_DIR, 'entity-extraction.schema.json'));

await ensureDir(CACHE_DIR);
await ensureDir(RUNS_DIR);
await ensureDir(REPORTS_DIR);
await ensureDir(runDir);

const [promptTemplate, schema] = await Promise.all([
  fs.readFile(promptPath, 'utf8'),
  readJsonFile(schemaPath),
]);

if (!schema) {
  throw new Error(`Schema file missing or invalid JSON: ${schemaPath}`);
}

if (!args.mock) {
  await verifyOllamaConnection({ ollamaHost, model });
}

const files = await listMarkdownFiles(notesDir);
if (files.length === 0) {
  throw new Error(`No markdown files found in ${notesDir}`);
}

const datasetKey = sha256(notesDir).slice(0, 16);
const cache = (await readJsonFile(cacheFilePath, makeEmptyCache())) ?? makeEmptyCache();
assertCacheShape(cache);

if (!cache.datasets[datasetKey]) {
  cache.datasets[datasetKey] = {
    notesDir,
    createdAt: runStartedAt,
    updatedAt: runStartedAt,
    notes: {},
  };
}

const dataset = cache.datasets[datasetKey];
dataset.notesDir = notesDir;

const noteRecords = await loadNoteRecords(files, notesDir, maxNoteChars);
if (args.maxNotes && args.maxNotes > 0) {
  noteRecords.splice(args.maxNotes);
}

const seenNoteIds = new Set(noteRecords.map(record => record.noteId));
for (const oldNoteId of Object.keys(dataset.notes)) {
  if (!seenNoteIds.has(oldNoteId)) {
    delete dataset.notes[oldNoteId];
  }
}

const toProcess = [];
const skipped = [];
for (const note of noteRecords) {
  const cached = dataset.notes[note.noteId];
  const unchanged = !args.force
    && cached
    && cached.hash === note.hash
    && cached.model === model
    && cached.promptVersion === PROMPT_VERSION
    && cached.schemaVersion === SCHEMA_VERSION;

  if (unchanged) {
    skipped.push({
      noteId: note.noteId,
      title: note.title,
      reason: 'unchanged',
      extractedAt: cached.extractedAt,
    });
    continue;
  }

  toProcess.push(note);
}

const processed = [];
const failed = [];

console.log(`[entity-lab] notes found: ${noteRecords.length}`);
console.log(`[entity-lab] notes to process: ${toProcess.length}`);
console.log(`[entity-lab] skipped unchanged: ${skipped.length}`);
console.log(`[entity-lab] mode: ${args.mock ? 'mock' : 'ollama'} | model: ${model}`);

for (let index = 0; index < toProcess.length; index += 1) {
  const note = toProcess[index];
  const started = performance.now();

  try {
    const prompt = buildUserPrompt(promptTemplate, note.title, note.content);
    const rawPayload = args.mock
      ? generateMockModelPayload(note)
      : await runOllamaExtraction({
        ollamaHost,
        model,
        schema,
        prompt,
      });

    const parsed = parseModelJson(rawPayload);
    const { extraction, warnings } = sanitizeExtraction(parsed, note.content);

    const durationMs = Math.round(performance.now() - started);
    const cacheEntry = {
      noteId: note.noteId,
      sourcePath: note.sourcePath,
      title: note.title,
      hash: note.hash,
      mtimeMs: note.mtimeMs,
      model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      durationMs,
      extraction,
    };

    dataset.notes[note.noteId] = cacheEntry;
    processed.push({
      noteId: note.noteId,
      title: note.title,
      durationMs,
      entityCount: extraction.entities.length,
      warnings,
    });

    const progress = `${index + 1}/${toProcess.length}`;
    console.log(`[entity-lab] processed ${progress}: ${note.noteId} (${durationMs}ms, entities=${extraction.entities.length})`);
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    failed.push({
      noteId: note.noteId,
      title: note.title,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[entity-lab] failed: ${note.noteId} (${durationMs}ms)`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

dataset.updatedAt = new Date().toISOString();
cache.updatedAt = dataset.updatedAt;
await writeJsonFile(cacheFilePath, cache);

const summary = {
  runId,
  runDir,
  runStartedAt,
  runFinishedAt: new Date().toISOString(),
  notesDir,
  datasetKey,
  mode: args.mock ? 'mock' : 'ollama',
  model,
  promptVersion: PROMPT_VERSION,
  schemaVersion: SCHEMA_VERSION,
  counts: {
    totalNotes: noteRecords.length,
    processed: processed.length,
    skipped: skipped.length,
    failed: failed.length,
  },
  failures: failed.slice(0, 20),
};

await Promise.all([
  writeJsonFile(path.join(runDir, 'summary.json'), summary),
  writeJsonFile(path.join(runDir, 'processed.json'), processed),
  writeJsonFile(path.join(runDir, 'skipped.json'), skipped),
  writeJsonFile(path.join(runDir, 'failed.json'), failed),
  writeJsonFile(path.join(RUNS_DIR, 'latest.json'), summary),
]);

if (failed.length > 0) {
  console.error(`[entity-lab] completed with failures: ${failed.length}`);
  process.exitCode = 2;
} else {
  console.log('[entity-lab] extraction complete.');
}

function parseArgs(argv) {
  const argsOut = {
    notesDir: '',
    cacheFile: '',
    outputDir: '',
    promptFile: '',
    schemaFile: '',
    model: '',
    ollamaHost: '',
    force: false,
    maxNotes: 0,
    maxNoteChars: 0,
    help: false,
    mock: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--notes-dir') {
      argsOut.notesDir = argv[++i] ?? '';
      continue;
    }
    if (arg === '--cache-file') {
      argsOut.cacheFile = argv[++i] ?? '';
      continue;
    }
    if (arg === '--output-dir') {
      argsOut.outputDir = argv[++i] ?? '';
      continue;
    }
    if (arg === '--prompt-file') {
      argsOut.promptFile = argv[++i] ?? '';
      continue;
    }
    if (arg === '--schema-file') {
      argsOut.schemaFile = argv[++i] ?? '';
      continue;
    }
    if (arg === '--model') {
      argsOut.model = argv[++i] ?? '';
      continue;
    }
    if (arg === '--ollama-host') {
      argsOut.ollamaHost = argv[++i] ?? '';
      continue;
    }
    if (arg === '--max-notes') {
      argsOut.maxNotes = Number(argv[++i] ?? '0');
      continue;
    }
    if (arg === '--max-note-chars') {
      argsOut.maxNoteChars = Number(argv[++i] ?? '0');
      continue;
    }
    if (arg === '--force') {
      argsOut.force = true;
      continue;
    }
    if (arg === '--mock') {
      argsOut.mock = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      argsOut.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return argsOut;
}

async function loadNoteRecords(files, notesDir, maxNoteChars) {
  const records = [];

  for (const sourcePath of files) {
    const [contentRaw, stat] = await Promise.all([
      fs.readFile(sourcePath, 'utf8'),
      fs.stat(sourcePath),
    ]);

    const relative = toPosixPath(path.relative(notesDir, sourcePath));
    const content = maxNoteChars > 0 ? contentRaw.slice(0, maxNoteChars) : contentRaw;

    records.push({
      noteId: relative,
      sourcePath,
      title: getNoteTitleFromPath(sourcePath),
      content,
      hash: sha256(contentRaw),
      mtimeMs: stat.mtimeMs,
    });
  }

  return records;
}

async function verifyOllamaConnection({ ollamaHost, model }) {
  let response;
  try {
    response = await fetch(`${ollamaHost}/api/tags`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    throw new Error(`Could not connect to Ollama at ${ollamaHost}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Ollama /api/tags failed with status ${response.status}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  const hasModel = models.some(item => item?.name === model || item?.model === model);
  if (!hasModel) {
    throw new Error(`Model not found in Ollama: ${model}. Run: ollama pull ${model}`);
  }
}

async function runOllamaExtraction({ ollamaHost, model, schema, prompt }) {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: schema,
      options: {
        temperature: 0.1,
      },
      messages: [
        {
          role: 'system',
          content: 'Extract entities from markdown notes and respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = await response.json();
  if (!payload?.message) {
    throw new Error('Ollama response missing message payload');
  }

  return payload.message.content;
}

function generateMockModelPayload(note) {
  const summary = note.content
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ') || 'No summary available.';

  const entities = [];

  const people = extractByRegex(note.content, /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g, 5);
  for (const name of people) {
    entities.push({
      type: 'person',
      name,
      aliases: [],
      confidence: 0.7,
      evidence: findEvidence(note.content, name),
    });
  }

  const projects = extractByRegex(note.content, /\b([A-Z][A-Za-z0-9]+\s+(?:launch|migration|project|roadmap))\b/gi, 5)
    .map(value => titleCase(value));
  for (const name of projects) {
    entities.push({
      type: 'project',
      name,
      aliases: [],
      confidence: 0.66,
      evidence: findEvidence(note.content, name),
    });
  }

  const tools = extractByRegex(note.content, /\b(GitHub|GitLab|PostgreSQL|SQLite|Docker|Kubernetes|Ollama|TypeScript|Svelte|Rust)\b/g, 6);
  for (const name of tools) {
    entities.push({
      type: 'tool',
      name,
      aliases: [],
      confidence: 0.72,
      evidence: findEvidence(note.content, name),
    });
  }

  return {
    summary,
    entities,
  };
}

function extractByRegex(content, regex, limit) {
  const found = [];
  const seen = new Set();

  for (const match of content.matchAll(regex)) {
    const value = (match[1] ?? match[0] ?? '').trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    found.push(value);
    if (found.length >= limit) break;
  }

  return found;
}

function findEvidence(content, entityName) {
  const lower = content.toLowerCase();
  const index = lower.indexOf(entityName.toLowerCase());
  if (index < 0) return [];
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + entityName.length + 60);
  return [content.slice(start, end).replace(/\s+/g, ' ').trim()];
}

function titleCase(value) {
  return value
    .split(' ')
    .map(part => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join(' ');
}

function makeEmptyCache() {
  return {
    version: CACHE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    datasets: {},
  };
}

function assertCacheShape(cache) {
  if (!cache || typeof cache !== 'object') {
    throw new Error('Invalid cache file format (expected object).');
  }

  if (cache.version !== CACHE_VERSION) {
    throw new Error(`Unsupported cache version ${cache.version}. Expected ${CACHE_VERSION}.`);
  }

  if (!cache.datasets || typeof cache.datasets !== 'object') {
    throw new Error('Invalid cache file format (missing datasets map).');
  }
}

function printHelp() {
  console.log(`Usage:
  node experiments/entity-lab/scripts/run-extraction.mjs --notes-dir <path> [options]

Options:
  --notes-dir <path>       Required. Root notes directory.
  --model <name>           Ollama model (default: qwen3:8b).
  --ollama-host <url>      Ollama host (default: http://127.0.0.1:11434).
  --output-dir <path>      Run output directory (default: experiments/entity-lab/runs/<timestamp>).
  --cache-file <path>      Cache file path.
  --prompt-file <path>     Prompt template file.
  --schema-file <path>     JSON schema file.
  --max-notes <n>          Process only first N notes.
  --max-note-chars <n>     Truncate note content before prompting (default: 12000).
  --force                  Ignore hash checkpoint and reprocess all notes.
  --mock                   Skip Ollama and use deterministic mock extraction.
  --help, -h               Show help.
`);
}
