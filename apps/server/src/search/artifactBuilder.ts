import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { log } from '../logger.js';

const ARTIFACT_VERSION = 'supersearch-v1';

interface ArtifactManifest {
  version: string;
  content_hash: string;
  chunk_count: number;
  dims: number;
  created_at: number;
  files: {
    vectors: string;
    manifest: string;
  };
}

/**
 * Build search artifacts in both SQLite and binary formats.
 * - SQLite: self-contained .db with search_chunks + search_vectors tables
 * - Binary: Float32Array dump + JSON manifest
 */
export async function buildArtifacts(
  sourceDb: DatabaseType.Database,
  artifactDir: string,
): Promise<{ version: string; hash: string }> {
  fs.mkdirSync(artifactDir, { recursive: true });

  // Get dims from search_config
  const dimsRow = sourceDb.prepare('SELECT value FROM search_config WHERE key = ?')
    .get('embedding_dims') as { value: string } | undefined;
  const dims = dimsRow ? parseInt(dimsRow.value, 10) : 384;

  // Get all chunks
  const chunks = sourceDb.prepare(`
    SELECT chunk_id, uuid, chunk_index, chunk_text, start_offset, end_offset, content_hash
    FROM search_chunks ORDER BY chunk_id
  `).all() as {
    chunk_id: number; uuid: string; chunk_index: number;
    chunk_text: string; start_offset: number; end_offset: number; content_hash: string;
  }[];

  // Compute content hash of all chunks for ETag/versioning
  const hashInput = chunks.map((c) => `${c.uuid}:${c.chunk_index}:${c.content_hash}`).join('\n');
  const contentHash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  // ── SQLite artifact ──────────────────────────────────
  const sqlitePath = path.join(artifactDir, `${ARTIFACT_VERSION}.db`);
  buildSqliteArtifact(sourceDb, sqlitePath, chunks, dims);

  // ── Binary artifact ──────────────────────────────────
  const binPath = path.join(artifactDir, `${ARTIFACT_VERSION}.bin`);
  const manifestPath = path.join(artifactDir, 'manifest.json');
  buildBinaryArtifact(sourceDb, binPath, manifestPath, chunks, dims, contentHash);

  // Store artifact metadata in source DB
  const now = Date.now();
  const upsert = sourceDb.prepare(`
    INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsert.run('artifact_version', ARTIFACT_VERSION, now);
  upsert.run('artifact_hash', contentHash, now);

  log.info(`search: built artifacts (${chunks.length} chunks, hash=${contentHash})`);
  return { version: ARTIFACT_VERSION, hash: contentHash };
}

function buildSqliteArtifact(
  sourceDb: DatabaseType.Database,
  outputPath: string,
  chunks: { chunk_id: number; uuid: string; chunk_index: number; chunk_text: string; start_offset: number; end_offset: number; content_hash: string }[],
  dims: number,
): void {
  // Remove existing artifact
  try { fs.unlinkSync(outputPath); } catch { /* ok */ }

  const artifactDb = new Database(outputPath);
  artifactDb.pragma('journal_mode = WAL');

  // Create tables
  artifactDb.exec(`
    CREATE TABLE search_chunks (
      chunk_id INTEGER PRIMARY KEY,
      uuid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(uuid, chunk_index)
    );
  `);

  // Load sqlite-vec extension into artifact DB
  // Note: this is done dynamically — the extension may or may not be available
  // depending on whether initVectorDb was called. We copy raw vector data instead.
  artifactDb.exec(`
    CREATE TABLE search_vectors_raw (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
    );
  `);

  // Copy chunks
  const insertChunk = artifactDb.prepare(`
    INSERT INTO search_chunks (chunk_id, uuid, chunk_index, chunk_text, start_offset, end_offset, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVector = artifactDb.prepare(`
    INSERT INTO search_vectors_raw (chunk_id, embedding)
    VALUES (?, ?)
  `);

  const copyAll = artifactDb.transaction(() => {
    for (const chunk of chunks) {
      insertChunk.run(chunk.chunk_id, chunk.uuid, chunk.chunk_index, chunk.chunk_text, chunk.start_offset, chunk.end_offset, chunk.content_hash);

      // Get vector from source DB
      const vec = sourceDb.prepare('SELECT embedding FROM search_vectors WHERE chunk_id = ?')
        .get(chunk.chunk_id) as { embedding: Buffer } | undefined;
      if (vec) {
        insertVector.run(chunk.chunk_id, vec.embedding);
      }
    }
  });
  copyAll();

  artifactDb.close();
  log.debug(`search: built SQLite artifact at ${outputPath}`);
}

function buildBinaryArtifact(
  sourceDb: DatabaseType.Database,
  binPath: string,
  manifestPath: string,
  chunks: { chunk_id: number; uuid: string; chunk_index: number; chunk_text: string; start_offset: number; end_offset: number; content_hash: string }[],
  dims: number,
  contentHash: string,
): void {
  // Build a flat Float32Array of all vectors, ordered by chunk_id
  const vectorCount = chunks.length;
  const totalFloats = vectorCount * dims;
  const buffer = new Float32Array(totalFloats);

  let idx = 0;
  for (const chunk of chunks) {
    const vec = sourceDb.prepare('SELECT embedding FROM search_vectors WHERE chunk_id = ?')
      .get(chunk.chunk_id) as { embedding: Buffer } | undefined;
    if (vec) {
      const floats = new Float32Array(vec.embedding.buffer, vec.embedding.byteOffset, dims);
      buffer.set(floats, idx * dims);
    }
    idx++;
  }

  // Write binary vectors
  fs.writeFileSync(binPath, Buffer.from(buffer.buffer));

  // Write manifest
  const manifest: ArtifactManifest = {
    version: ARTIFACT_VERSION,
    content_hash: contentHash,
    chunk_count: vectorCount,
    dims,
    created_at: Date.now(),
    files: {
      vectors: path.basename(binPath),
      manifest: path.basename(manifestPath),
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  log.debug(`search: built binary artifact at ${binPath}`);
}
