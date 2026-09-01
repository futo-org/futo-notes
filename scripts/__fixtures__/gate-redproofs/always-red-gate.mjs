// Self-test fixture for scripts/gate-redproofs.mjs: a gate that is already red
// on a pristine checkout. Its red-proof would "pass" for the wrong reason, so
// the harness must REJECT it on the GREEN direction (verdict 'green-not-clean')
// before the seeded violation is ever applied.
console.error('fixture gate FAILED: redproof-selftest-violation-detected (always, even pristine).');
process.exit(1);
