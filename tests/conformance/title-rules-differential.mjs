// The TypeScript<->Rust note-rule differential.
//
// The checked-in `tests/conformance/*.json` corpora are the reviewed behavioral
// truth: a human decided what each rule SHOULD answer for a few hundred inputs.
// This file has a different job. It asks the TypeScript copy and the canonical
// Rust implementation the SAME tens of thousands of questions and fails when
// their answers differ - no expectations to author, no goldens to regenerate,
// and no way for a rule to drift in one language and stay green in the other.
//
//   node --experimental-strip-types tests/conformance/title-rules-differential.mjs
//   ... --family=tags --family=preview   # narrow while debugging (PARTIAL run)
//   ... --all                            # print every disagreement, not the first 25
//
// Reached by `just test-rust`, `just test-rust-full`, and CI's
// `test:rust:workspace`. Full orientation - what each corpus is, how to add a
// case or a family, what this supersedes - is in `tests/conformance/README.md`.
//
// Properties this file must keep:
//   * DETERMINISTIC. Fixed-seed xorshift only; never `Math.random()`, never the
//     clock. A red run must reproduce byte-for-byte on the next run.
//   * ONE Rust process. The whole corpus goes to the oracle
//     (`crates/futo-notes-model/examples/title_rule_oracle.rs`) as a single JSON
//     batch, so growing the corpus costs microseconds, not cargo startups.
//   * NO SILENT PASS (M11). `assertEveryFixtureOpIsCovered` fails if a fixture op
//     exists that this differential does not probe; every KNOWN_DIVERGENCES entry
//     must STILL diverge, so a fix cannot leave a stale exclusion behind; and the
//     suppressed counts are printed even on a green run.
//
// The filename is historical: this began as a title-only differential and the
// `justfile`, `.gitlab-ci.yml`, and `scripts/drift-registry.json` all reference
// this path. It now covers every rule family the fixtures cover.
//
// EVERY non-printable-ASCII code point below is written as a `\uXXXX` escape, on
// purpose. A literal zero-width or non-breaking character in source is
// unreviewable and is silently normalized by some editors - which weakens the
// corpus without failing anything.

import { spawnSync } from 'node:child_process';
import {
  assertEveryFixtureOpIsCovered,
  canon,
  comparable,
  describe,
} from './title-rules-differential/comparison.mjs';
import { FAMILIES } from './title-rules-differential/families.mjs';
import { KNOWN_DIVERGENCES } from './title-rules-differential/known-gaps.mjs';
import { ROOT } from './title-rules-differential/paths.mjs';
import { TS_OPS } from './title-rules-differential/ts-ops.mjs';

// --- Run --------------------------------------------------------------------

const selected = process.argv
  .filter((arg) => arg.startsWith('--family='))
  .map((arg) => arg.slice('--family='.length));
const families = selected.length
  ? FAMILIES.filter((family) => selected.includes(family.name))
  : FAMILIES;
if (selected.length > 0 && families.length !== new Set(selected).size) {
  process.stderr.write(
    `Unknown --family. Known families: ${FAMILIES.map((family) => family.name).join(', ')}\n`,
  );
  process.exit(1);
}

const probes = [];
for (const family of families) {
  for (const probe of family.probes()) probes.push({ family: family.name, ...probe });
}
// Closure probes ride along in the same batch, but only on a full run: a narrowed
// --family run must not fail because an unrelated entry went unexercised.
const closureProbes = selected.length === 0;
if (closureProbes) {
  for (const divergence of KNOWN_DIVERGENCES) {
    for (const probe of divergence.probes) {
      probes.push({ family: 'closure-probe', divergenceId: divergence.id, ...probe });
    }
  }
  assertEveryFixtureOpIsCovered(
    new Set(probes.filter((probe) => !probe.divergenceId).map((probe) => probe.op)),
  );
}

const rust = spawnSync(
  'cargo',
  ['run', '--quiet', '-p', 'futo-notes-model', '--example', 'title_rule_oracle'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(probes.map(({ op, input }) => ({ op, input }))),
    maxBuffer: 512 * 1024 * 1024,
  },
);
if (rust.status !== 0) {
  process.stderr.write(rust.stderr || '');
  process.stderr.write(`\nThe Rust rule oracle exited ${rust.status}. Nothing was compared.\n`);
  process.exit(rust.status ?? 1);
}

const rustAnswers = JSON.parse(rust.stdout);
if (rustAnswers.length !== probes.length) {
  process.stderr.write(
    `Oracle returned ${rustAnswers.length} answers for ${probes.length} probes.\n`,
  );
  process.exit(1);
}

const suppressed = new Map(KNOWN_DIVERGENCES.map((divergence) => [divergence.id, 0]));
const healed = [];
const mismatches = [];
const perFamily = new Map();

for (let index = 0; index < probes.length; index += 1) {
  const probe = probes[index];
  if (!probe.divergenceId) {
    const counts = perFamily.get(probe.family) ?? { probes: 0, ops: new Set() };
    counts.probes += 1;
    counts.ops.add(probe.op);
    perFamily.set(probe.family, counts);
  }

  const typescript = comparable(probe.op, probe.input, TS_OPS[probe.op](probe.input));
  const rustAnswer = comparable(probe.op, probe.input, rustAnswers[index]);
  const agree = canon(typescript) === canon(rustAnswer);

  // A closure probe MUST still diverge; agreement means the cause was fixed and
  // the KNOWN_DIVERGENCES entry is now hiding real coverage.
  if (probe.divergenceId) {
    if (agree) healed.push({ ...probe, typescript, rust: rustAnswer });
    continue;
  }
  if (agree) continue;

  const excuse = KNOWN_DIVERGENCES.find(
    (divergence) => divergence.ops.has(probe.op) && divergence.matches(probe.input),
  );
  if (excuse) {
    suppressed.set(excuse.id, suppressed.get(excuse.id) + 1);
    continue;
  }
  mismatches.push({ ...probe, typescript, rust: rustAnswer });
}

if (healed.length > 0) {
  process.stderr.write(
    '\nRULE DIFFERENTIAL FAILED - a recorded divergence no longer diverges. The two\n' +
      'languages now AGREE on these closure probes, so the KNOWN_DIVERGENCES entry is\n' +
      'suppressing real coverage. Narrow it, or delete it.\n\n' +
      healed
        .map(
          (probe) =>
            `  entry "${probe.divergenceId}" op=${probe.op} input=${describe(probe.input)}\n` +
            `    both languages answered: ${describe(probe.typescript)}\n`,
        )
        .join('') +
      '\n',
  );
  process.exit(1);
}

if (mismatches.length > 0) {
  const shown = process.argv.includes('--all') ? mismatches : mismatches.slice(0, 25);
  const byOp = new Map();
  for (const mismatch of mismatches) {
    const key = `${mismatch.family}/${mismatch.op}`;
    byOp.set(key, (byOp.get(key) ?? 0) + 1);
  }
  process.stderr.write(
    '\nRULE DIFFERENTIAL FAILED - the TypeScript and Rust note rules disagree on ' +
      `${mismatches.length} of ${probes.length} probes.\n\n` +
      'Disagreements by rule:\n' +
      [...byOp.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `  ${String(count).padStart(6)}  ${key}\n`)
        .join('') +
      '\n' +
      shown
        .map(
          (mismatch, position) =>
            `[${position + 1}] family=${mismatch.family} op=${mismatch.op}\n` +
            `    input:      ${describe(mismatch.input)}\n` +
            `    typescript: ${describe(mismatch.typescript)}\n` +
            `    rust:       ${describe(mismatch.rust)}\n`,
        )
        .join('\n') +
      (mismatches.length > shown.length
        ? `\n... and ${mismatches.length - shown.length} more (re-run with --all).\n`
        : '') +
      '\nRust is canonical (AGENTS.md M6/M7). Fix the TypeScript copy under\n' +
      'packages/editor/src/ (or src/shared/note/wikilinks.ts) unless the Rust rule is\n' +
      'the one that is wrong - then change BOTH, update the reviewed goldens in\n' +
      'tests/conformance/*.json, and record the behavior change in docs/spec/.\n' +
      'See tests/conformance/README.md.\n',
  );
  process.exit(1);
}

const compared = probes.filter((probe) => !probe.divergenceId).length;
const summary = [...perFamily.entries()]
  .map(
    ([name, counts]) =>
      `  ${name.padEnd(10)} ${String(counts.probes).padStart(6)} probes over ` +
      `${counts.ops.size} ops`,
  )
  .join('\n');
// The suppressed counts print on a GREEN run on purpose: a divergence nobody sees
// in the output is a divergence nobody fixes.
const excuses = [...suppressed.entries()]
  .map(([id, count]) => `  ${String(count).padStart(6)} suppressed by KNOWN_DIVERGENCES "${id}"`)
  .join('\n');
process.stdout.write(
  `Rule differential OK - TypeScript and Rust agree on ${compared} probes across ` +
    `${families.length} famil${families.length === 1 ? 'y' : 'ies'}:\n${summary}\n` +
    (excuses ? `${excuses}\n` : '') +
    (closureProbes
      ? `  ${String(probes.length - compared).padStart(6)} closure probes still diverging\n`
      : '') +
    (selected.length > 0 ? 'PARTIAL RUN - coverage guard skipped (--family given).\n' : ''),
);
