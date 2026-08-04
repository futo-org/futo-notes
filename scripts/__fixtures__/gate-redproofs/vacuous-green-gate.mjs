// Self-test fixture for scripts/gate-redproofs.mjs: a gate that exits 0 no
// matter what — the "silent green" failure this whole harness exists to catch.
// The harness must REJECT it (verdict 'gate-not-red'); if it ever reports this
// fixture as ok, every other ok in the report is worthless.
console.log('fixture gate OK — (this gate never fails, which is the point).');
