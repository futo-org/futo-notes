#!/usr/bin/env node
/**
 * Standalone embedding test script.
 * Benchmarks hardware → downloads model → embeds all notes → runs test searches.
 *
 * Usage: node apps/server/scripts/test-embeddings.mjs [--model bge-small|qwen-0.6b]
 */

import { getLlama, resolveModelFile } from 'node-llama-cpp';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { createInterface } from 'readline';

// ─── Config ─────────────────────────────────────────────────────────────────

const NOTES_DIR = path.join(process.env.HOME, 'Documents', 'stonefruit');
const MODELS_DIR = path.join(process.env.HOME, '.cache', 'futo-notes-models');
const DB_PATH = '/tmp/futo-notes-embedding-test.db';

const MODELS = {
  'bge-small': {
    name: 'bge-small-en-v1.5',
    hfUri: 'hf:CompendiumLabs/bge-small-en-v1.5-gguf:bge-small-en-v1.5-q8_0.gguf',
  },
  'qwen-0.6b': {
    name: 'Qwen3-Embedding-0.6B',
    hfUri: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf',
  },
};

// ─── Chunker (from server/src/search/chunker.ts) ────────────────────────────

function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

const TARGET_TOKENS = 900;
const SHORT_NOTE_THRESHOLD = 512;

function chunkContent(content) {
  if (!content.trim()) return [];
  if (estimateTokens(content) < SHORT_NOTE_THRESHOLD) {
    return [{ text: content, startOffset: 0, endOffset: content.length }];
  }
  const sections = splitAtBoundaries(content);
  return mergeWithOverlap(sections);
}

function splitAtBoundaries(content) {
  const sections = [];
  const pattern = /(?=^#{1,6}\s)/m;
  const headingSplits = [];
  let offset = 0;
  for (const part of content.split(pattern)) {
    if (part.length > 0) {
      headingSplits.push({ text: part, startOffset: offset, endOffset: offset + part.length });
    }
    offset += part.length;
  }
  for (const section of headingSplits) {
    if (estimateTokens(section.text) <= TARGET_TOKENS) {
      sections.push(section);
      continue;
    }
    let innerOffset = section.startOffset;
    const paraParts = section.text.split(/\n\n+/);
    for (let i = 0; i < paraParts.length; i++) {
      const para = paraParts[i];
      if (para.length > 0) {
        const actualStart = content.indexOf(para, innerOffset);
        const start = actualStart >= 0 ? actualStart : innerOffset;
        const s = { text: para, startOffset: start, endOffset: start + para.length };
        if (estimateTokens(s.text) <= TARGET_TOKENS) {
          sections.push(s);
        } else {
          // Split by word count
          const words = s.text.split(/(\s+)/);
          const targetWords = Math.floor(TARGET_TOKENS / 1.3);
          let cw = [], wc = 0, co = s.startOffset;
          for (const token of words) {
            cw.push(token);
            if (token.trim()) wc++;
            if (wc >= targetWords) {
              const t = cw.join('');
              sections.push({ text: t, startOffset: co, endOffset: co + t.length });
              co += t.length; cw = []; wc = 0;
            }
          }
          if (cw.length > 0) {
            const t = cw.join('');
            if (t.trim()) sections.push({ text: t, startOffset: co, endOffset: co + t.length });
          }
        }
      }
      innerOffset += para.length;
      if (i < paraParts.length - 1) {
        const ns = content.indexOf(paraParts[i + 1], innerOffset);
        if (ns > innerOffset) innerOffset = ns;
      }
    }
  }
  return sections;
}

function mergeWithOverlap(sections) {
  if (!sections.length) return [];
  const chunks = [];
  let ct = '', cs = sections[0].startOffset, ce = sections[0].endOffset;
  for (const s of sections) {
    if (ct && estimateTokens(ct + '\n\n' + s.text) > TARGET_TOKENS) {
      chunks.push({ text: ct, startOffset: cs, endOffset: ce });
      const overlapTokens = Math.floor(TARGET_TOKENS * 0.15);
      const words = ct.split(/\s+/).filter(Boolean);
      const wc = Math.floor(overlapTokens / 1.3);
      const overlap = wc < words.length ? words.slice(-wc).join(' ') : ct;
      ct = overlap + '\n\n' + s.text;
      cs = ce - overlap.length;
      ce = s.endOffset;
    } else if (!ct) {
      ct = s.text; cs = s.startOffset; ce = s.endOffset;
    } else {
      ct += '\n\n' + s.text; ce = s.endOffset;
    }
  }
  if (ct) chunks.push({ text: ct, startOffset: cs, endOffset: ce });
  return chunks;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function printSection(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(70)}\n`);
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(MODELS_DIR, { recursive: true });

  // Parse --model flag
  const modelArg = process.argv.find(a => a.startsWith('--model='));
  const modelKey = modelArg ? modelArg.split('=')[1] : null;

  // ── Step 1: Initialize llama.cpp ──────────────────────────────────────────
  printSection('1. Initializing llama.cpp');
  const llama = await getLlama();
  console.log(`  GPU: ${llama.gpu || 'none (CPU only)'}`);

  // ── Step 2: Benchmark both candidate models ──────────────────────────────
  printSection('2. Benchmarking Embedding Models');

  const BENCH_TEXT = `The quick brown fox jumps over the lazy dog. This is a benchmark passage designed to be approximately 256 tokens long for testing embedding model performance on typical note content. Notes can contain a variety of topics including technical documentation, personal thoughts, meeting notes, and creative writing. The embedding model needs to handle all of these well. When evaluating model performance, we measure the wall-clock time to embed a single passage. This gives us a good estimate of how long it will take to process an entire note collection.`;

  const benchResults = [];

  for (const [key, cfg] of Object.entries(MODELS)) {
    console.log(`\n  Testing ${cfg.name}...`);
    try {
      const mPath = await resolveModelFile(cfg.hfUri, MODELS_DIR);
      const m = await llama.loadModel({ modelPath: mPath });
      const ctx = await m.createEmbeddingContext();

      // Warmup
      await ctx.getEmbeddingFor('warmup');

      // Benchmark: 5 runs, take median
      const times = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await ctx.getEmbeddingFor(BENCH_TEXT);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const medianMs = times[Math.floor(times.length / 2)];
      const sampleEmbed = await ctx.getEmbeddingFor('test');
      const dims = sampleEmbed.vector.length;

      await ctx.dispose();
      await m.dispose();

      console.log(`    Times: [${times.map(t => formatMs(t)).join(', ')}]`);
      console.log(`    Median: ${formatMs(medianMs)}, Dims: ${dims}`);

      benchResults.push({ key, cfg, medianMs, dims, modelPath: mPath });
    } catch (err) {
      console.log(`    Failed: ${err.message}`);
    }
  }

  // Print benchmark table
  console.log('\n  ┌──────────────────────────┬───────┬────────────┐');
  console.log('  │ Model                    │ Dims  │ Median     │');
  console.log('  ├──────────────────────────┼───────┼────────────┤');
  for (const r of benchResults) {
    console.log(`  │ ${r.cfg.name.padEnd(25)}│ ${String(r.dims).padEnd(6)}│ ${formatMs(r.medianMs).padEnd(11)}│`);
  }
  console.log('  └──────────────────────────┴───────┴────────────┘');

  // Select model: use flag, or pick best quality that's under 200ms/embed
  let selected;
  if (modelKey && benchResults.find(r => r.key === modelKey)) {
    selected = benchResults.find(r => r.key === modelKey);
    console.log(`\n  Using requested model: ${selected.cfg.name}`);
  } else {
    // Prefer qwen-0.6b if it's under 200ms, else bge-small
    const qwen = benchResults.find(r => r.key === 'qwen-0.6b');
    const bge = benchResults.find(r => r.key === 'bge-small');
    if (qwen && qwen.medianMs < 200) {
      selected = qwen;
    } else if (bge) {
      selected = bge;
    } else {
      selected = benchResults[0];
    }
    console.log(`\n  Auto-selected: ${selected.cfg.name} (${formatMs(selected.medianMs)}/embed)`);
  }

  // ── Step 3: Load selected model ───────────────────────────────────────────
  printSection('3. Loading Selected Model');

  console.log(`  ${selected.cfg.name} (${selected.dims}d)`);
  const model = await llama.loadModel({ modelPath: selected.modelPath });
  const embeddingContext = await model.createEmbeddingContext();
  const dims = selected.dims;
  console.log(`  Ready. Dims: ${dims}`);

  // ── Step 4: Read and chunk all notes ──────────────────────────────────────
  printSection('4. Reading and Chunking Notes');

  const files = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
  console.log(`  Found ${files.length} .md files`);

  const notes = [];
  let totalChunks = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const content = readFileSync(path.join(NOTES_DIR, file), 'utf-8');
      const title = file.replace(/\.md$/, '');
      const chunks = chunkContent(content);
      if (chunks.length === 0) { skipped++; continue; }
      notes.push({ filename: file, title, content, chunks });
      totalChunks += chunks.length;
    } catch (err) {
      console.warn(`  Skipping ${file}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`  Notes with content: ${notes.length}`);
  console.log(`  Skipped (empty/error): ${skipped}`);
  console.log(`  Total chunks: ${totalChunks}`);
  console.log(`  Avg chunks/note: ${(totalChunks / notes.length).toFixed(1)}`);

  // ── Step 5: Set up SQLite + sqlite-vec ────────────────────────────────────
  printSection('5. Setting Up Database');

  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE notes (
      filename TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE chunks (
      chunk_id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      UNIQUE(filename, chunk_index)
    );
    CREATE VIRTUAL TABLE vectors USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dims}]
    );
  `);
  console.log(`  DB: ${DB_PATH}`);

  // ── Step 6: Embed all notes ───────────────────────────────────────────────
  printSection('6. Embedding All Notes');

  const insertNote = db.prepare('INSERT INTO notes (filename, title, content) VALUES (?, ?, ?)');
  const insertChunk = db.prepare('INSERT INTO chunks (chunk_id, filename, chunk_index, chunk_text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO vectors (chunk_id, embedding) VALUES (?, ?)');

  const embedStart = performance.now();
  let chunksEmbedded = 0;
  let nextChunkId = 1;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];

    // Insert note metadata
    insertNote.run(note.filename, note.title, note.content);

    // Assign chunk IDs manually (sqlite-vec needs plain integers, not BigInt)
    const chunkIds = [];
    const txn = db.transaction(() => {
      for (let j = 0; j < note.chunks.length; j++) {
        const chunk = note.chunks[j];
        const cid = nextChunkId++;
        insertChunk.run(cid, note.filename, j, chunk.text, chunk.startOffset, chunk.endOffset);
        chunkIds.push(cid);
      }
    });
    txn();

    // Embed chunks and insert vectors
    for (let j = 0; j < note.chunks.length; j++) {
      const embedding = await embeddingContext.getEmbeddingFor(note.chunks[j].text);
      const buf = new Float32Array(embedding.vector);
      insertVector.run(BigInt(chunkIds[j]), Buffer.from(buf.buffer));
      chunksEmbedded++;
    }

    // Progress every 50 notes
    if ((i + 1) % 50 === 0 || i === notes.length - 1) {
      const elapsed = performance.now() - embedStart;
      const rate = chunksEmbedded / (elapsed / 1000);
      const remaining = totalChunks - chunksEmbedded;
      const eta = remaining / rate;
      console.log(
        `  [${i + 1}/${notes.length}] ${chunksEmbedded}/${totalChunks} chunks | ` +
        `${rate.toFixed(1)} chunks/s | ETA ${formatMs(eta * 1000)}`
      );
    }
  }

  const totalEmbedMs = performance.now() - embedStart;
  const dbSize = statSync(DB_PATH).size;

  console.log(`\n  Done! ${chunksEmbedded} chunks in ${formatMs(totalEmbedMs)}`);
  console.log(`  Avg per chunk: ${formatMs(totalEmbedMs / chunksEmbedded)}`);
  console.log(`  Avg per note: ${formatMs(totalEmbedMs / notes.length)}`);
  console.log(`  DB size: ${(dbSize / 1024 / 1024).toFixed(1)} MB`);

  // ── Step 7: Test searches ─────────────────────────────────────────────────
  printSection('7. Semantic Search Tests');

  async function search(query, topK = 15) {
    const qStart = performance.now();
    const queryEmbed = await embeddingContext.getEmbeddingFor(query);
    const embedMs = performance.now() - qStart;

    const searchStart = performance.now();
    const buf = new Float32Array(queryEmbed.vector);
    const results = db.prepare(`
      SELECT v.chunk_id, v.distance, c.filename, c.chunk_index, c.chunk_text, c.start_offset
      FROM vectors v
      JOIN chunks c ON c.chunk_id = v.chunk_id
      WHERE v.embedding MATCH ? AND v.k = ?
      ORDER BY v.distance
    `).all(Buffer.from(buf.buffer), topK);
    const searchMs = performance.now() - searchStart;

    return { results, embedMs, searchMs, totalMs: embedMs + searchMs };
  }

  function printResults(query, res) {
    console.log(`\n  Query: "${query}"`);
    console.log(`  Time: embed=${formatMs(res.embedMs)} search=${formatMs(res.searchMs)} total=${formatMs(res.totalMs)}`);

    // Deduplicate by filename, keep best distance
    const seen = new Map();
    for (const r of res.results) {
      if (!seen.has(r.filename) || r.distance < seen.get(r.filename).distance) {
        seen.set(r.filename, r);
      }
    }
    const deduped = [...seen.values()].sort((a, b) => a.distance - b.distance);

    for (let i = 0; i < Math.min(deduped.length, 7); i++) {
      const r = deduped[i];
      const title = r.filename.replace(/\.md$/, '');
      const snippet = r.chunk_text.slice(0, 120).replace(/\n/g, ' ').trim();
      console.log(`    ${i + 1}. [${r.distance.toFixed(4)}] ${title}`);
      console.log(`       ${snippet}...`);
    }
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

  for (const q of queries) {
    const res = await search(q, 15);
    printResults(q, res);
  }

  // ── Step 8: Interactive search ────────────────────────────────────────────
  printSection('8. Interactive Search (type queries, Ctrl+C to exit)');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.question('\n  Search> ', async (query) => {
      if (!query.trim()) { prompt(); return; }
      const res = await search(query.trim(), 15);
      printResults(query.trim(), res);
      prompt();
    });
  };
  prompt();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
