// Self-test fixture for scripts/gate-redproofs.mjs: a gate that behaves the
// way every real gate is supposed to — silent and green until the violation is
// present, then non-zero AND naming what it found. The harness must accept it.
import { sentinelExists } from './sentinel.mjs';

if (sentinelExists()) {
  console.error('fixture gate: redproof-selftest-violation-detected in the seeded sentinel file.');
  process.exit(1);
}

console.log('fixture gate OK — no seeded violation present.');
