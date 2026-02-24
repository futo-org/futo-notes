/**
 * Standalone benchmark script — downloads bge-small and times embedding inference.
 * Run: npx tsx scripts/run-benchmark.ts
 */

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

const HF_URI = 'hf:CompendiumLabs/bge-small-en-v1.5-gguf:bge-small-en-v1.5-q8_0.gguf';
const MODELS_DIR = 'data/models';
const WARMUP = 1;
const RUNS = 5;

async function main() {
  const fs = await import('node:fs');
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  console.log('Resolving model file (downloading if needed)...');
  const llamaCpp: Record<string, unknown> = await import('node-llama-cpp');
  const resolve = llamaCpp['resolveModelFile'] as (uri: string, dir: string) => Promise<string>;
  const modelPath = await resolve(HF_URI, MODELS_DIR);
  console.log(`Model path: ${modelPath}\n`);

  const { getLlama } = await import('node-llama-cpp');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  // Warmup
  console.log(`Warming up (${WARMUP} run)...`);
  for (let i = 0; i < WARMUP; i++) {
    await context.getEmbeddingFor(SAMPLE_TEXT);
  }

  // Timed runs
  console.log(`Running ${RUNS} timed embeddings...\n`);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const result = await context.getEmbeddingFor(SAMPLE_TEXT);
    const elapsed = performance.now() - start;
    times.push(elapsed);
    console.log(`  Run ${i + 1}: ${elapsed.toFixed(2)}ms  (vector dims: ${result.vector.length})`);
  }

  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  console.log(`\n── Results ──`);
  console.log(`  Min:    ${Math.min(...times).toFixed(2)}ms`);
  console.log(`  Median: ${median.toFixed(2)}ms`);
  console.log(`  Max:    ${Math.max(...times).toFixed(2)}ms`);

  // Model selection
  let selected: string;
  if (median < 10) selected = 'qwen3-embedding-8b (4096d → 1024d MRL)';
  else if (median < 30) selected = 'qwen3-embedding-4b (2560d → 1024d MRL)';
  else if (median < 100) selected = 'qwen3-embedding-0.6b (1024d)';
  else if (median < 500) selected = 'bge-small-en-v1.5 (384d)';
  else selected = 'SKIP — hardware too slow';

  console.log(`\n  → Selected model: ${selected}`);

  await context.dispose();
  await model.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
