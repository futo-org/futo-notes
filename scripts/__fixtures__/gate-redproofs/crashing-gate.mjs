// Self-test fixture for scripts/gate-redproofs.mjs: a gate that exits non-zero
// on the seeded violation but never names it — the shape of a gate that died on
// a missing dependency rather than detecting anything. The harness must REJECT
// it (verdict 'marker-missing'); accepting it would make every red-proof an
// exit-code check, which is precisely what this harness forbids.
import { sentinelExists } from './sentinel.mjs';

if (sentinelExists()) {
  console.error("Error: Cannot find module 'some-unrelated-dependency'");
  process.exit(1);
}

console.log('fixture gate OK — no seeded violation present.');
