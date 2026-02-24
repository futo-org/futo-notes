import type Database from 'better-sqlite3';
import type { ModelDef } from './modelRegistry.js';
import { BENCHMARK_MODEL_ID, getModelDef, MODEL_REGISTRY } from './modelRegistry.js';
import { log } from '../logger.js';

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

const WARMUP_RUNS = 1;
const BENCH_RUNS = 5;

/**
 * Select a model from the registry based on bge-small benchmark median time.
 */
export function selectModel(medianMs: number): ModelDef | null {
  if (medianMs < 10) return getModelDef('qwen3-embedding-8b')!;
  if (medianMs < 30) return getModelDef('qwen3-embedding-4b')!;
  if (medianMs < 100) return getModelDef('qwen3-embedding-0.6b')!;
  if (medianMs < 500) return getModelDef('bge-small-en-v1.5')!;
  return null; // Too slow, skip embeddings
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface BenchmarkResult {
  selectedModelId: string | null;
  benchMedianMs: number;
}

/**
 * Run a hardware benchmark to determine the best embedding model.
 * Downloads bge-small (~37MB), embeds sample text 5 times, takes median,
 * then selects a model from the registry based on speed thresholds.
 *
 * Caches result in search_config — returns cached result on subsequent calls.
 */
export async function runBenchmark(
  db: Database.Database,
  modelsDir: string,
): Promise<BenchmarkResult> {
  // Check cache
  const existing = db.prepare('SELECT value FROM search_config WHERE key = ?')
    .get('benchmark_result') as { value: string } | undefined;
  if (existing) {
    const cached = JSON.parse(existing.value) as BenchmarkResult;
    log.info(`search: using cached benchmark — selected ${cached.selectedModelId} (median=${cached.benchMedianMs}ms)`);
    return cached;
  }

  log.info('search: running hardware benchmark...');

  const benchModelDef = getModelDef(BENCHMARK_MODEL_ID);
  if (!benchModelDef) throw new Error(`Benchmark model ${BENCHMARK_MODEL_ID} not in registry`);

  const { resolveModelFile } = await import('./modelManager.js');
  const modelPath = await resolveModelFile(benchModelDef.hfUri, modelsDir);

  const { getLlama } = await import('node-llama-cpp');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  try {
    // Warmup
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await context.getEmbeddingFor(SAMPLE_TEXT);
    }

    // Timed runs
    const times: number[] = [];
    for (let i = 0; i < BENCH_RUNS; i++) {
      const start = performance.now();
      await context.getEmbeddingFor(SAMPLE_TEXT);
      times.push(performance.now() - start);
    }

    const medianMs = Math.round(median(times));
    const selected = selectModel(medianMs);

    const result: BenchmarkResult = {
      selectedModelId: selected?.id ?? null,
      benchMedianMs: medianMs,
    };

    // Store results
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upsert.run('benchmark_result', JSON.stringify(result), now);

    if (selected) {
      upsert.run('embedding_model', selected.id, now);
      upsert.run('embedding_dims', String(selected.dims), now);
      if (selected.queryPrefix) {
        upsert.run('query_prefix', selected.queryPrefix, now);
      }
      log.info(`search: benchmark complete — median=${medianMs}ms → ${selected.id} (${selected.dims}d)`);
    } else {
      log.warn(`search: hardware too slow (median=${medianMs}ms), skipping embeddings`);
    }

    return result;
  } finally {
    await context.dispose();
    await model.dispose();
  }
}
