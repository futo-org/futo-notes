import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { MilkdownGauntletAdapter } from './milkdownAdapter';
import {
  MILKDOWN_FLOOR_FIXTURES,
  PERFORMANCE_BUDGET,
  evaluatePerformanceFloor,
  runPerformanceFloor,
} from './performanceFloor';

/**
 * The performance floor, on the budget policy docs/plan/milkdown-transition.md
 * §5 sets: a hard 1 s open at sizes real notes reach, and "scales linearly, no
 * cliff" above them. The keystroke budget applies at every size (M5).
 *
 * This is the DESKTOP leg. The plan's budgets are also owed on the low-end
 * Android reference device, which no browser harness can stand in for; that
 * leg belongs to the progressive-open work, not here.
 */
test('milkdown meets the editor performance floor', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const adapter = new MilkdownGauntletAdapter(browser);
  let results;
  try {
    results = await runPerformanceFloor(adapter, MILKDOWN_FLOOR_FIXTURES);
  } finally {
    await adapter.dispose();
  }

  const violations = evaluatePerformanceFloor(MILKDOWN_FLOOR_FIXTURES, results);
  const report = {
    candidate: adapter.name,
    budget: PERFORMANCE_BUDGET,
    policy: MILKDOWN_FLOOR_FIXTURES.map((fixture) => ({
      fixture: fixture.name,
      openPolicy: fixture.openPolicy,
    })),
    results,
    violations,
  };
  const reportDir = path.resolve('tests/editor-gauntlet/local');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'milkdown-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`EDITOR_GAUNTLET_PERF ${JSON.stringify(report)}`);

  expect(
    results.map((result) => result.fixture),
    'every fixture must produce a measurement',
  ).toEqual(MILKDOWN_FLOOR_FIXTURES.map((fixture) => fixture.name));
  expect(violations, 'the performance floor must hold').toEqual([]);
});
