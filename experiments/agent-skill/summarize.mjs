#!/usr/bin/env node
/**
 * Every scored run, one table per arm.
 *
 *   node summarize.mjs [--json]
 *
 * Reads the newest scorecard in each scenario/arm and prints the signals side
 * by side. A run with no scorecard is shown as `-` rather than skipped, because
 * a missing grade is a fact about the batch, not an absence of one.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, 'work');
const ARMS = [
  'baseline',
  'treatment',
  'routed',
  'observed',
  'current',
  'desktop-input',
  'single-skill',
];

const rows = [];
for (const entry of readdirSync(workRoot).filter((e) => !e.startsWith('.'))) {
  const match =
    /^(.+)--(baseline|treatment|routed|observed|current|desktop-input|single-skill)(-\d+)?$/.exec(
      entry,
    );
  if (!match) continue;
  const [, scenario, arm] = match;
  const runsDir = join(workRoot, entry, 'runs');
  if (!existsSync(runsDir)) continue;
  for (const runId of readdirSync(runsDir).sort().slice(-1)) {
    const card = join(runsDir, runId, 'scorecard.json');
    if (!existsSync(card)) {
      rows.push({ scenario, arm, ungraded: true });
      continue;
    }
    rows.push({ scenario, arm, ...JSON.parse(readFileSync(card, 'utf8')) });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const mark = (value) => (value === true ? 'yes' : value === false ? ' . ' : ' - ');
const COLUMNS = [
  ['fixed', (r) => mark(r.fixed)],
  ['file', (r) => mark(r.touchedTheRightFile)],
  ['cause', (r) => mark(r.judgement?.sameRootCause)],
  ['papers', (r) => mark(r.judgement?.papersOver)],
  ['realApp', (r) => mark(r.judgement?.ranRealApp)],
  ['agentCli', (r) => mark(r.judgement?.usedAgentCli)],
  ['repro1st', (r) => mark(r.judgement?.reproducedFirst)],
  ['rightPlace', (r) => mark(r.judgement?.verifiedWhereTheBugLives)],
  ['tools', (r) => String(r.toolCalls ?? '-')],
  ['secs', (r) => String(r.elapsedSeconds ?? '-')],
];

for (const arm of ARMS) {
  const inArm = rows.filter((r) => r.arm === arm);
  if (!inArm.length) continue;
  console.log(`\n── ${arm} ${'─'.repeat(72 - arm.length)}`);
  console.log(`${'scenario'.padEnd(30)}${COLUMNS.map(([h]) => h.padStart(11)).join('')}`);
  for (const row of inArm.sort((a, b) => a.scenario.localeCompare(b.scenario))) {
    if (row.ungraded) {
      console.log(`${row.scenario.padEnd(30)}${'(not graded)'.padStart(11)}`);
      continue;
    }
    console.log(
      `${row.scenario.padEnd(30)}${COLUMNS.map(([, get]) => get(row).padStart(11)).join('')}`,
    );
  }
  const graded = inArm.filter((r) => !r.ungraded);
  const tally = (pick) => graded.filter(pick).length;
  console.log(
    `${'—'.padEnd(30)}${
      `${tally((r) => r.judgement?.ranRealApp)}/${graded.length} ran the real app · ` +
      `${tally((r) => r.judgement?.usedAgentCli)}/${graded.length} used the CLI · ` +
      `${tally((r) => r.judgement?.reproducedFirst)}/${graded.length} reproduced first · ` +
      `${tally((r) => r.judgement?.sameRootCause)}/${graded.length} right cause`
    }`,
  );
}
console.log();
