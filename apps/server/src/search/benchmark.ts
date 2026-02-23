import type Database from 'better-sqlite3';
import { log } from '../logger.js';

export interface BenchmarkResult {
  modelName: string;
  dims: number;
  wallTimeMs: number;
}

export interface ModelTier {
  name: string;
  dims: number;
}

const SAMPLE_TEXT = `
The quick brown fox jumps over the lazy dog. This is a benchmark passage
designed to be approximately 256 tokens long for testing embedding model
performance on typical note content. Notes can contain a variety of topics
including technical documentation, personal thoughts, meeting notes, and
creative writing. The embedding model needs to handle all of these well.

When evaluating model performance, we measure the wall-clock time to embed
a single passage. This gives us a good estimate of how long it will take
to process an entire note collection. Faster models allow us to use larger
embedding dimensions, which generally produce better search results.

The tradeoff between speed and quality is important: a large model that
takes too long will make the indexing process impractical, while a tiny
model that runs quickly may not produce useful embeddings for search.
We use tiered selection to pick the best model for the available hardware.
`.trim();

/**
 * Select model tier based on wall time:
 * <50ms -> large (1024d), <200ms -> medium (512d),
 * <500ms -> small (384d), <2s -> tiny (384d), >2s -> skip
 */
export function selectModelTier(wallTimeMs: number): ModelTier | null {
  if (wallTimeMs < 50) return { name: 'large', dims: 1024 };
  if (wallTimeMs < 200) return { name: 'medium', dims: 512 };
  if (wallTimeMs < 500) return { name: 'small', dims: 384 };
  if (wallTimeMs < 2000) return { name: 'tiny', dims: 384 };
  return null; // Too slow, skip embedding
}

/**
 * Run a hardware benchmark to determine the best embedding model tier.
 * Stores result in search_config table.
 * Returns the selected model tier, or null if hardware is too slow.
 */
export async function runBenchmark(
  db: Database.Database,
  overrideModel?: string,
): Promise<BenchmarkResult | null> {
  // Check if benchmark already ran
  const existing = db.prepare('SELECT value FROM search_config WHERE key = ?')
    .get('benchmark_result') as { value: string } | undefined;
  if (existing) {
    const cached = JSON.parse(existing.value) as BenchmarkResult;
    log.info(`search: using cached benchmark result: ${cached.modelName} (${cached.wallTimeMs}ms)`);
    return cached;
  }

  log.info('search: running hardware benchmark...');

  try {
    // Dynamic import — only loaded when SEARCH_ENABLED=true
    const { loadEmbeddingModel, embedTexts, unloadModel } = await import('./modelManager.js');

    // Use override or try with default model
    const modelName = overrideModel || 'default';
    const model = await loadEmbeddingModel(modelName);

    const start = performance.now();
    await embedTexts(model, [SAMPLE_TEXT]);
    const wallTimeMs = Math.round(performance.now() - start);

    await unloadModel();

    const tier = overrideModel
      ? { name: overrideModel, dims: 384 } // User override uses specified model
      : selectModelTier(wallTimeMs);

    if (!tier) {
      log.warn(`search: hardware too slow (${wallTimeMs}ms), skipping embeddings`);
      return null;
    }

    const result: BenchmarkResult = {
      modelName: tier.name,
      dims: tier.dims,
      wallTimeMs,
    };

    // Store result
    const now = Date.now();
    db.prepare(`
      INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('benchmark_result', JSON.stringify(result), now);
    db.prepare(`
      INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('embedding_model', result.modelName, now);
    db.prepare(`
      INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('embedding_dims', String(result.dims), now);

    log.info(`search: benchmark complete: ${result.modelName} ${result.dims}d (${wallTimeMs}ms)`);
    return result;
  } catch (err) {
    log.error(`search: benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
