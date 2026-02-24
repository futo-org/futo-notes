#!/usr/bin/env node
/**
 * Re-run searches with Qwen3 query instruction prefix.
 * Uses the existing cosine DB (documents were embedded without prefix, which is correct).
 * Only changes the query embedding to use the instruction format.
 */

import { getLlama, resolveModelFile } from 'node-llama-cpp';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { performance } from 'perf_hooks';
import { createInterface } from 'readline';

const MODELS_DIR = path.join(process.env.HOME, '.cache', 'futo-notes-models');
const DB_PATH = path.join(process.env.HOME, '.cache', 'futo-notes-embedding-cosine.db');

const llama = await getLlama();
const modelPath = await resolveModelFile(
  'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf',
  MODELS_DIR,
);
const model = await llama.loadModel({ modelPath });
const ctx = await model.createEmbeddingContext();

const db = new Database(DB_PATH, { readonly: true });
sqliteVec.load(db);

const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
const noteCount = db.prepare('SELECT COUNT(*) as n FROM notes').get().n;
console.log(`DB: ${noteCount} notes, ${chunkCount} chunks\n`);

// Qwen3-Embedding instruction format for queries
const QUERY_PREFIX = 'Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ';

async function search(query, topK = 15, usePrefix = true) {
  const fullQuery = usePrefix ? QUERY_PREFIX + query : query;
  const s1 = performance.now();
  const qe = await ctx.getEmbeddingFor(fullQuery);
  const embedMs = performance.now() - s1;
  const s2 = performance.now();
  const buf = new Float32Array(qe.vector);
  const results = db.prepare(`
    SELECT v.chunk_id, v.distance, c.filename, c.chunk_text, c.chunk_index
    FROM vectors v JOIN chunks c ON c.chunk_id = v.chunk_id
    WHERE v.embedding MATCH ? AND v.k = ?
    ORDER BY v.distance
  `).all(Buffer.from(buf.buffer), topK);
  const searchMs = performance.now() - s2;
  return { results, embedMs, searchMs };
}

function show(query, res, label = '') {
  console.log(`${label}Query: "${query}"  (embed=${Math.round(res.embedMs)}ms search=${Math.round(res.searchMs)}ms)`);
  const seen = new Map();
  for (const r of res.results) {
    if (!seen.has(r.filename) || r.distance < seen.get(r.filename).distance) {
      seen.set(r.filename, r);
    }
  }
  const d = [...seen.values()].sort((a, b) => a.distance - b.distance);
  for (let i = 0; i < Math.min(d.length, 7); i++) {
    const r = d[i];
    const title = r.filename.replace(/\.md$/, '');
    const snippet = r.chunk_text.slice(0, 120).replace(/\n/g, ' ').trim();
    console.log(`  ${i + 1}. [sim=${(1 - r.distance).toFixed(4)}] ${title}`);
    console.log(`     ${snippet}...`);
  }
  console.log();
}

const queries = [
  'grocery list',
  'recipe',
  'things I need to do',
  'how I feel about my job',
  'places I want to travel',
  'ideas for projects',
  'meeting notes',
  'programming',
  'music',
  'health and exercise',
  'money and finances',
  'things that make me happy',
  'problems I need to solve',
  'relationships and friends',
];

console.log('═══ WITH Instruct prefix (recommended for Qwen3) ═══\n');
for (const q of queries) {
  show(q, await search(q, 15, true));
}

console.log('\n═══ WITHOUT prefix (raw query, for comparison) ═══\n');
for (const q of queries) {
  show(q, await search(q, 15, false));
}

// Interactive mode
console.log('\n═══ Interactive Search (with prefix) ═══');
console.log('  Type a query and press Enter. Ctrl+C to exit.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => {
  rl.question('Search> ', async (query) => {
    if (!query.trim()) { prompt(); return; }
    console.log();
    show(query.trim(), await search(query.trim(), 15, true), '  [prefix] ');
    show(query.trim(), await search(query.trim(), 15, false), '  [raw]    ');
    prompt();
  });
};
prompt();
