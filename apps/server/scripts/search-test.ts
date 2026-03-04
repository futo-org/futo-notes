/**
 * End-to-end semantic search test against real notes.
 *
 * 1. Downloads qwen3-embedding-8b (~8.1GB) if not cached
 * 2. Reads all .md files from NOTES_DIR
 * 3. Chunks and embeds them (with MIN_WORDS filter)
 * 4. Stores vectors in an in-memory SQLite DB (cosine distance)
 * 5. Runs a battery of search queries and prints results
 *
 * Run: npx tsx scripts/search-test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const NOTES_DIR = '/home/justin/Documents/stonefruit';
const MODELS_DIR = '/home/justin/Developer/futo-notes/apps/server/data/models';

// Qwen3-Embedding-8B config
const MODEL = {
  id: 'qwen3-embedding-8b',
  hfUri: 'hf:Qwen/Qwen3-Embedding-8B-GGUF:Qwen3-Embedding-8B-Q8_0.gguf',
  nativeDims: 4096,
  dims: 1024,
  queryPrefix: 'Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ',
};

const TOP_K = 5;
const BATCH_SIZE = 32;
const MIN_WORDS = 10;
const CACHE_FILE = '/home/justin/Developer/futo-notes/apps/server/data/search-test-cache.json';

// ─── Chunker (simplified: whole-note embedding for speed) ────────────
interface Chunk {
  noteFile: string;
  text: string;
}

function chunkNote(filename: string, content: string): Chunk[] {
  if (!content.trim()) return [];
  if (content.split(/\s+/).filter(Boolean).length < MIN_WORDS) return [];
  // For this test, embed whole note (truncated to ~2000 words to fit context)
  const words = content.split(/\s+/).filter(Boolean);
  const text = words.slice(0, 2000).join(' ');
  return [{ noteFile: filename, text }];
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // 1. Resolve and download model
  console.log(`\n📦 Resolving model: ${MODEL.id}...`);
  const llamaCpp: Record<string, unknown> = await import('node-llama-cpp');
  const resolve = llamaCpp['resolveModelFile'] as (uri: string, dir: string) => Promise<string>;
  const modelPath = await resolve(MODEL.hfUri, MODELS_DIR);
  console.log(`   Model path: ${modelPath}\n`);

  const { getLlama } = await import('node-llama-cpp');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  // Helper: embed with optional prefix, truncate to dims
  async function embed(text: string, prefix?: string): Promise<number[]> {
    const input = prefix ? prefix + text : text;
    const result = await context.getEmbeddingFor(input);
    return Array.from(result.vector).slice(0, MODEL.dims);
  }

  // 2. Read notes
  console.log(`📂 Reading notes from ${NOTES_DIR}...`);
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
  console.log(`   Found ${files.length} .md files\n`);

  // 3. Chunk
  console.log(`✂️  Chunking (min ${MIN_WORDS} words)...`);
  const chunks: Chunk[] = [];
  let skipped = 0;
  for (const file of files) {
    const content = fs.readFileSync(path.join(NOTES_DIR, file), 'utf8');
    const noteChunks = chunkNote(file, content);
    if (noteChunks.length === 0) {
      skipped++;
      continue;
    }
    chunks.push(...noteChunks);
  }
  console.log(`   ${chunks.length} chunks from ${files.length - skipped} notes (${skipped} skipped < ${MIN_WORDS} words)\n`);

  // 4. Embed all chunks (with caching)
  let embeddings: number[][];

  // Try to load from cache
  const chunkFingerprint = chunks.map(c => c.noteFile).join('\n');
  let cacheHit = false;
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached.fingerprint === chunkFingerprint && cached.embeddings.length === chunks.length) {
        embeddings = cached.embeddings;
        cacheHit = true;
        console.log(`🧠 Loaded ${embeddings.length} cached embeddings from ${CACHE_FILE}\n`);
      }
    } catch { /* ignore bad cache */ }
  }

  if (!cacheHit) {
    console.log(`🧠 Embedding ${chunks.length} chunks with ${MODEL.id} (${MODEL.dims}d)...`);
    embeddings = [];
    const startEmbed = performance.now();
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      for (const chunk of batch) {
        embeddings.push(await embed(chunk.text)); // docs: no prefix
      }
      const pct = Math.min(100, Math.round(((i + batch.length) / chunks.length) * 100));
      const elapsed = ((performance.now() - startEmbed) / 1000).toFixed(1);
      process.stdout.write(`\r   ${i + batch.length}/${chunks.length} (${pct}%) — ${elapsed}s`);
    }
    const totalEmbedTime = ((performance.now() - startEmbed) / 1000).toFixed(1);
    const perNote = ((performance.now() - startEmbed) / chunks.length).toFixed(1);
    console.log(`\n   Done in ${totalEmbedTime}s (${perNote}ms/note)\n`);

    // Save cache
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint: chunkFingerprint, embeddings }));
    console.log(`   Saved cache to ${CACHE_FILE}\n`);
  }

  // 5. Build in-memory vector DB
  console.log(`🗄️  Building vector index (sqlite-vec, cosine)...`);
  const db = new Database(':memory:');
  const sqliteVec = await import('sqlite-vec');
  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE vectors USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[${MODEL.dims}] distance_metric=cosine
    );
  `);

  const insert = db.prepare('INSERT INTO vectors (id, embedding) VALUES (?, ?)');
  const txn = db.transaction(() => {
    for (let i = 0; i < embeddings.length; i++) {
      const buf = new Float32Array(embeddings[i]);
      insert.run(BigInt(i), Buffer.from(buf.buffer));
    }
  });
  txn();
  console.log(`   Indexed ${embeddings.length} vectors\n`);

  // 6. Search!
  const queries = [
    // Exact keyword matches — should be easy
    'grocery list',
    'raspberry pi',
    'atomic bomb',

    // Semantic / conceptual
    'recipes for cooking dinner',
    'feeling anxious about the future',
    'tips for job interviews',
    'how to be more productive',
    'relationship advice',

    // Topical
    'machine learning and AI projects',
    'travel planning',
    'fitness and working out',
    'music recommendations',
    'personal finance and budgeting',

    // Abstract / vibe
    'moments of self reflection',
    'creative project ideas',
    'things I want to learn',
    'funny ideas and jokes',
  ];

  console.log(`🔍 Running ${queries.length} search queries (top ${TOP_K} results each):\n`);
  console.log('═'.repeat(80));

  const searchStmt = db.prepare(`
    SELECT id, distance FROM vectors
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `);

  for (const query of queries) {
    const qStart = performance.now();
    const qVec = await embed(query, MODEL.queryPrefix);
    const embedMs = (performance.now() - qStart).toFixed(1);

    const sStart = performance.now();
    const buf = new Float32Array(qVec);
    const results = searchStmt.all(Buffer.from(buf.buffer), TOP_K) as { id: number; distance: number }[];
    const searchMs = (performance.now() - sStart).toFixed(1);

    console.log(`\n  "${query}"  (embed: ${embedMs}ms, search: ${searchMs}ms)`);
    console.log('  ' + '─'.repeat(76));
    for (const r of results) {
      const chunk = chunks[r.id];
      const title = chunk.noteFile.replace(/\.md$/, '');
      const dist = r.distance.toFixed(4);
      const snippet = chunk.text.slice(0, 120).replace(/\n/g, ' ').trim();
      console.log(`  ${dist}  ${title}`);
      console.log(`         ${snippet}...`);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`\nDone. ${chunks.length} notes indexed, ${queries.length} queries run.`);

  await context.dispose();
  await model.dispose();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
