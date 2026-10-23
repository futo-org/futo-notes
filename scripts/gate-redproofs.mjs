// Targeted gate red-proof harness — proves changed gates work.
//
//   node scripts/gate-redproofs.mjs
//   node scripts/gate-redproofs.mjs --help         (usage only; no worktree)
//   node scripts/gate-redproofs.mjs --self-test    (only the harness self-test)
//   node scripts/gate-redproofs.mjs --include-cargo  (adds the cargo-dependent proof)
//
// WHY THIS EXISTS. "Silent green" is this repo's #1 root-cause class, and the
// guards themselves are not exempt: d87173eb (a commented-out invoke() counted
// as a live caller), 54d1cc41 (the ratchet counted files, not call sites; the
// drift registry missed the canonical copy), 90a62902 (the drift scan matched
// only one literal shape), a6c6e2d5 (the ratchet's compare loop never read an
// unmatched JSON entry, so a retired counter could never be retired),
// db31586c (the docs-only CI fast path skipped check-agent-docs). Every one of
// those gates was GREEN while stepping over a real violation. Every gate this
// repo has added later needed a red-proof it did not originally have. This
// harness remains available for gate changes, but is deliberately outside the
// routine `just check`/`prepush` path so unchanged conclusions are not re-proved
// on every commit (AGENTS.md M11: no silent green).
//
// WHAT IT PROVES. For each covered gate, both directions:
//   GREEN — the gate exits 0 on a pristine checkout (otherwise a red-proof is
//           vacuous: a gate that is always red proves nothing).
//   RED   — with ONE seeded violation injected, the gate exits non-zero AND
//           its output names the seeded violation. Exit-code-only is
//           deliberately not accepted: a gate that dies on a missing module
//           also exits non-zero, and counting that as "the gate works" is the
//           exact failure this harness exists to catch.
//
// HOW. One throwaway `git worktree` in the system temp dir (never inside the
// repo — a stray directory there would itself trip drift-check's
// deny-by-default scan). Per proof: inject → run the gate with cwd there →
// assert → revert → assert the worktree is byte-clean again. The real
// checkout is never touched.
//
// SOURCE SNAPSHOT. A disposable Git index captures the working tree, including
// non-ignored untracked source, without staging files or touching refs/stash.
// Ignored generated output remains outside the proof checkout.
//
// ADDING A GATE. Append to PROOFS below: the gate command, one seeded
// violation that hits the gate's PRIMARY claim, the substrings its output must
// contain, and a `fix:` line telling the next person what to do when the proof
// goes red. A proof without a marker assertion is not a proof.
//
// Note for editors: this harness is documented here and in the justfile
// recipe rather than in AGENTS.md, to keep the root manual to rules agents
// must follow rather than rationale for the tooling that checks them.

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Gate commands (how each gate is invoked inside the proof worktree)
// ---------------------------------------------------------------------------

const GATES = {
  'command-reachability': ['node', ['scripts/check-command-reachability.mjs']],
  'platform-discipline': ['node', ['scripts/check-platform-discipline.mjs']],
  'drift-check': ['node', ['scripts/drift-check.mjs']],
  'agent-docs': ['node', ['scripts/check-agent-docs.mjs']],
  'qa-input-safety': ['node', ['scripts/check-qa-input-safety.mjs']],
  'toolbar-spec': ['node_modules/.bin/tsx', ['scripts/gen-toolbar-spec.ts', '--check']],
  'title-spec': ['node_modules/.bin/tsx', ['scripts/gen-title-spec.ts', '--check']],
  'bridge-spec': ['node_modules/.bin/tsx', ['scripts/gen-bridge-spec.ts', '--check']],
  'theme-single-pace': ['node', ['scripts/check-theme-single-pace.mjs']],
  'supporter-coin-glyph': ['node', ['scripts/check-supporter-coin-glyph.mjs']],
  'rust-dependency-boundaries': ['node', ['scripts/check-rust-dependency-boundaries.mjs']],
};

// Gates whose proof needs a Rust toolchain. Kept out of the default run so the
// default command stays usable on machines and CI images without cargo.
// `--include-cargo` opts into these proofs explicitly.
const CARGO_GATES = new Set(['rust-dependency-boundaries']);

// Gates this harness deliberately does NOT cover, printed on every run so the
// hole is visible rather than assumed closed (M11 applies to the harness too).
const NOT_COVERED = [
  {
    gate: 'sync-contract (cargo test -p futo-notes-tauri generated_typescript_contract_is_current)',
    why: 'the proof would have to compile the desktop Tauri crate (GTK/webkit link, minutes per run) — far outside this harness’s seconds-scale budget. It is exercised by the Rust workspace job instead.',
  },
  {
    gate: 'rust-lint (cargo clippy --workspace, print macros denied by [workspace.lints])',
    why: 'the proof would have to clippy-check the whole workspace, desktop Tauri crate included, from a cold target dir in the throwaway worktree (minutes per run). The Rust workspace job runs the gate; a seeded println! in apps/tauri/src-tauri/src/instance_journal.rs fails it naming "use of `println!`" and the file.',
  },
  {
    gate: 'lint:platform (package.json git-grep one-liner)',
    why: 'not a script with its own failure reporting — it is a negated `git grep`, so a red run prints grep output and nothing else. The boundary it half-guards is red-proved by the platform-discipline proofs above.',
  },
];

import { PROOFS } from './gate-redproofs/proofs.mjs';
import { seed } from './gate-redproofs/seed.mjs';
import {
  createWorktree,
  destroyWorktree,
  resolveBase,
  revert,
} from './gate-redproofs/worktree.mjs';

// ---------------------------------------------------------------------------
// Harness self-test — proves the harness itself cannot go green vacuously
//
// Runs the SAME green/red machinery over fixture "gates" whose behavior is
// known, and asserts the verdict code. If the harness ever starts calling a
// gate that never fails, or one that fails without naming the violation, a
// PASS here, the self-test fails and the whole run is red.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = 'scripts/__fixtures__/gate-redproofs';
const FIXTURE_SENTINEL = `${FIXTURE_DIR}/seeded-violation`;

function fixtureGate(name) {
  return ['node', [`${FIXTURE_DIR}/${name}`]];
}

const SELF_TESTS = [
  {
    id: 'vacuous-green-gate-is-rejected',
    why: 'a gate that always exits 0 must never be reported as working',
    gate: fixtureGate('vacuous-green-gate.mjs'),
    expectCode: 'gate-not-red',
  },
  {
    id: 'exit-code-only-is-rejected',
    why: 'a gate that exits non-zero WITHOUT naming the violation (a crash) must not count',
    gate: fixtureGate('crashing-gate.mjs'),
    expectCode: 'marker-missing',
  },
  {
    id: 'already-red-gate-is-rejected',
    why: 'a gate that is red on a pristine checkout makes its own red-proof vacuous',
    gate: fixtureGate('always-red-gate.mjs'),
    expectCode: 'green-not-clean',
  },
  {
    id: 'honest-gate-passes',
    why: 'the machinery must still accept a gate that genuinely detects and reports',
    gate: fixtureGate('honest-gate.mjs'),
    expectCode: 'ok',
  },
];

const SELF_TEST_PROOF = {
  seeded: `created ${FIXTURE_SENTINEL}`,
  inject: (wt) => seed.write(wt, FIXTURE_SENTINEL, 'redproof-selftest-violation\n'),
  expect: ['redproof-selftest-violation-detected'],
};

function runGate(wt, [command, args]) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: wt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    spawnError: result.error ? result.error.message : null,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// The two directions
// ---------------------------------------------------------------------------

function proveGreen(wt, gate) {
  const run = runGate(wt, gate);
  if (run.spawnError) {
    return { code: 'green-spawn-failed', detail: run.spawnError, ms: run.ms };
  }
  if (run.status !== 0) {
    return { code: 'green-not-clean', detail: tail(run.output), ms: run.ms };
  }
  return { code: 'ok', detail: null, ms: run.ms };
}

function proveRed(wt, gate, proof) {
  const expected = typeof proof.expect === 'function' ? proof.expect(wt) : proof.expect;
  try {
    proof.inject(wt);
  } catch (error) {
    revert(wt);
    return { code: 'inject-failed', detail: error.message, ms: 0, expected };
  }

  const run = runGate(wt, gate);
  revert(wt);

  if (run.spawnError) {
    return { code: 'red-spawn-failed', detail: run.spawnError, ms: run.ms, expected };
  }
  if (run.status === 0) {
    return { code: 'gate-not-red', detail: tail(run.output), ms: run.ms, expected };
  }
  const missing = expected.filter((needle) => !run.output.includes(needle));
  if (missing.length > 0) {
    return {
      code: 'marker-missing',
      detail: `output never mentioned ${missing.map((m) => JSON.stringify(m)).join(', ')}\n${tail(run.output)}`,
      ms: run.ms,
      expected,
    };
  }
  const forbidden = (proof.absent ?? []).filter((needle) => run.output.includes(needle));
  if (forbidden.length > 0) {
    return {
      code: 'marker-forbidden',
      detail: `output also reported ${forbidden.map((m) => JSON.stringify(m)).join(', ')} — the gate is failing indiscriminately, not detecting this violation\n${tail(run.output)}`,
      ms: run.ms,
      expected,
    };
  }
  return { code: 'ok', detail: null, ms: run.ms, expected };
}

function tail(text, lines = 8) {
  const trimmed = text.trim();
  if (trimmed === '') return '(no output at all)';
  return trimmed
    .split('\n')
    .slice(-lines)
    .map((line) => `      | ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const REMEDIATION = {
  'green-spawn-failed':
    'the gate could not be launched in a fresh checkout. Run `pnpm install` (tsx gates need node_modules), then re-run.',
  'green-not-clean':
    'the gate is ALREADY red on a pristine checkout, so its red-proof would prove nothing. Fix the violation the gate is reporting (above), or fix the gate. ' +
    'The proof snapshot includes tracked edits and non-ignored untracked source; check whether the reported path is ignored or generated.',
  'inject-failed':
    'the seeded violation could not be applied — the file or literal this proof edits moved. Update the proof in scripts/gate-redproofs.mjs so it seeds the same violation against the current code.',
  'red-spawn-failed': 'the gate could not be launched. Run `pnpm install`, then re-run.',
  'gate-not-red':
    'the gate PASSED over a real seeded violation. It is protecting nothing. Do not weaken this proof to make it green.',
  'marker-missing':
    'the gate exited non-zero but never named the seeded violation — that is a crash or an unrelated failure, not a detection. Exit code alone is not proof.',
  'marker-forbidden':
    'the gate reported violations it should not have, so a non-zero exit here does not mean it found THIS one.',
};

function report(kind, name, result, extra = {}) {
  if (result.code === 'ok') {
    const marker = extra.marker ? `  [${extra.marker} marker]` : '';
    console.log(`  ok    ${name.padEnd(52)} ${String(result.ms).padStart(5)}ms${marker}`);
    return true;
  }
  console.log(`  FAIL  ${name.padEnd(52)} ${String(result.ms).padStart(5)}ms  (${result.code})`);
  if (extra.seeded) console.log(`        seeded: ${extra.seeded}`);
  if (extra.claim) console.log(`        claim:  ${extra.claim}`);
  if (result.expected) {
    console.log(
      `        wanted: output containing ${result.expected.map((m) => JSON.stringify(m)).join(', ')}`,
    );
  }
  if (result.detail) console.log(`        got:\n${result.detail}`);
  console.log(`        why:    ${REMEDIATION[result.code] ?? 'unexpected harness state.'}`);
  if (extra.fix) console.log(`        fix:    ${extra.fix}`);
  console.log('');
  return false;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function runSelfTest(wt) {
  console.log('SELF-TEST (the harness must reject a gate that cannot detect anything)');
  let failures = 0;
  for (const testCase of SELF_TESTS) {
    const green = proveGreen(wt, testCase.gate);
    const actual =
      green.code !== 'ok' ? green.code : proveRed(wt, testCase.gate, SELF_TEST_PROOF).code;
    if (actual === testCase.expectCode) {
      console.log(`  ok    ${testCase.id.padEnd(52)} verdict '${actual}'`);
      continue;
    }
    failures++;
    console.log(
      `  FAIL  ${testCase.id.padEnd(52)} verdict '${actual}', wanted '${testCase.expectCode}'`,
    );
    console.log(`        why:    ${testCase.why}`);
    console.log(
      '        fix:    the harness engine in scripts/gate-redproofs.mjs no longer classifies this case correctly. ' +
        'Until it does, every "ok" it prints for a real gate is unearned — fix proveGreen()/proveRed() before trusting any other line of this report.',
    );
    console.log('');
  }
  console.log('');
  return failures;
}

function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.find(
    (arg) => !['--help', '-h', '--self-test', '--include-cargo'].includes(arg),
  );
  if (unknown) {
    console.error(`Unknown argument: ${unknown}`);
    console.error('Usage: node scripts/gate-redproofs.mjs [--self-test] [--include-cargo]');
    return 1;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/gate-redproofs.mjs [--self-test] [--include-cargo]');
    console.log('  --self-test      Run only the harness self-test.');
    console.log('  --include-cargo  Include proofs that need a Rust toolchain.');
    return 0;
  }
  const selfTestOnly = argv.includes('--self-test');
  const includeCargo = argv.includes('--include-cargo');

  // Inside the try: a plumbing failure here (git refusing, a spawn overflowing)
  // must surface as the ABORTED harness report below, never as a bare stack
  // trace that reads like a crash of unknown consequence.
  let worktree = null;
  let failures = 0;

  try {
    const base = resolveBase();
    worktree = createWorktree(base.rev);
    const started = Date.now();

    console.log('Gate red-proof harness — every guard must actually fail on its own violation.');
    console.log(`  proving: ${base.label}`);
    console.log(`  worktree: ${worktree.wt}`);
    console.log('');

    failures += runSelfTest(worktree.wt);
    if (selfTestOnly) return failures;

    const skipped = [];
    const gateNames = Object.keys(GATES).filter((name) => {
      if (CARGO_GATES.has(name) && !includeCargo) {
        skipped.push({
          gate: name,
          why: 'needs a Rust toolchain, so the default portable command omits it. Re-run with --include-cargo.',
        });
        return false;
      }
      return true;
    });

    console.log('GREEN — each gate exits 0 on a pristine checkout');
    const usable = [];
    for (const name of gateNames) {
      const result = proveGreen(worktree.wt, GATES[name]);
      if (report('green', name, result, { fix: null })) usable.push(name);
      else failures++;
    }
    console.log('');

    console.log('RED — each gate exits non-zero AND names the seeded violation');
    let redCount = 0;
    for (const proof of PROOFS) {
      if (!gateNames.includes(proof.gate)) continue;
      const name = `${proof.gate}/${proof.id}`;
      if (!usable.includes(proof.gate)) {
        console.log(`  skip  ${name.padEnd(52)}        (its GREEN direction failed above)`);
        failures++;
        continue;
      }
      redCount++;
      const result = proveRed(worktree.wt, GATES[proof.gate], proof);
      if (!report('red', name, result, proof)) failures++;
    }
    console.log('');

    if (skipped.length > 0 || NOT_COVERED.length > 0) {
      console.log(
        'NOT COVERED (stated, not assumed — a hole you cannot see is worse than one you can)',
      );
      for (const item of [...skipped, ...NOT_COVERED]) {
        console.log(`  -  ${item.gate}\n     ${item.why}`);
      }
      console.log('');
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (failures > 0) {
      console.error(
        `Gate red-proof harness FAILED — ${failures} issue(s) across ${gateNames.length} gate(s) / ${redCount} red-proof(s) in ${seconds}s.`,
      );
      console.error(
        'A failure here means a guard this repo relies on is not guarding. Fix the gate (or the proof, if the gate changed on purpose) — never delete the proof to get green.',
      );
      return failures;
    }
    console.log(
      `Gate red-proof harness OK — ${gateNames.length} gate(s) green on a pristine tree and red on ${redCount} seeded violation(s), ${seconds}s.`,
    );
    return 0;
  } catch (error) {
    // Reaching here means the plumbing broke (a seeded violation could not be
    // reverted, git refused, …). Report it as a harness failure rather than a
    // bare stack trace: a crashed harness proves nothing, and must never be
    // mistaken for a pass.
    console.error(`\nGate red-proof harness ABORTED: ${error.message}`);
    console.error(
      'The harness could not complete, so NOTHING was proved on this run. Re-run after fixing the ' +
        'above; if a proof left files behind, they live only in the throwaway worktree printed at the top.',
    );
    return 1;
  } finally {
    if (worktree) destroyWorktree(worktree);
  }
}

process.exit(main() > 0 ? 1 : 0);
