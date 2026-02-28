import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectModel } from './search/benchmark.js';
import { resolveModelFile } from './search/modelManager.js';
import { BENCHMARK_MODEL_ID, getModelDef } from './search/modelRegistry.js';

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
const MODELS_DIR = 'data/models';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function runBenchmarkCli(): Promise<void> {
  const benchmarkModel = getModelDef(BENCHMARK_MODEL_ID);
  if (!benchmarkModel) {
    throw new Error(`Benchmark model "${BENCHMARK_MODEL_ID}" not found in registry`);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });

  console.log(`Resolving benchmark model (${benchmarkModel.id})...`);
  const modelPath = await resolveModelFile(benchmarkModel.hfUri, MODELS_DIR);
  console.log(`Model path: ${modelPath}\n`);

  const { getLlama } = await import('node-llama-cpp');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  try {
    console.log(`Warming up (${WARMUP_RUNS} run)...`);
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await context.getEmbeddingFor(SAMPLE_TEXT);
    }

    console.log(`Running ${BENCH_RUNS} timed embeddings...\n`);

    const times: number[] = [];
    let vectorDims = 0;

    for (let i = 0; i < BENCH_RUNS; i++) {
      const start = performance.now();
      const result = await context.getEmbeddingFor(SAMPLE_TEXT);
      const elapsed = performance.now() - start;
      vectorDims = result.vector.length;
      times.push(elapsed);
      console.log(`  Run ${i + 1}: ${elapsed.toFixed(2)}ms  (vector dims: ${vectorDims})`);
    }

    const medianMs = Math.round(median(times));
    const selected = selectModel(medianMs);

    console.log('\n-- Results --');
    console.log(`  Min:    ${Math.min(...times).toFixed(2)}ms`);
    console.log(`  Median: ${medianMs.toFixed(2)}ms`);
    console.log(`  Max:    ${Math.max(...times).toFixed(2)}ms`);
    console.log(`  -> Selected model: ${selected?.id ?? 'SKIP (hardware too slow)'}`);
  } finally {
    await context.dispose();
    await model.dispose();
  }
}

async function main(): Promise<void> {
  await runBenchmarkCli();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
