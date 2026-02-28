/**
 * Standalone benchmark script.
 * Run: npx tsx scripts/run-benchmark.ts
 */
import { runBenchmarkCli } from '../src/benchmark.ts';

runBenchmarkCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
