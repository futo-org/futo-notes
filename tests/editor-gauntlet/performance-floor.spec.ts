import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { Cm6GauntletAdapter } from './cm6Adapter';
import { PERFORMANCE_BUDGET, runPerformanceFloor } from './performanceFloor';

test('current CM6 meets the editor performance floor', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const adapter = new Cm6GauntletAdapter(page);
  const results = await runPerformanceFloor(adapter);
  const report = { candidate: adapter.name, budget: PERFORMANCE_BUDGET, results };
  const reportDir = path.resolve('tests/editor-gauntlet/local');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'current-cm6-performance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`EDITOR_GAUNTLET_PERF ${JSON.stringify(report)}`);

  for (const result of results) {
    expect
      .soft(result.openMs, `${result.fixture} settled open`)
      .toBeLessThan(PERFORMANCE_BUDGET.openMs);
    expect(
      result.keystrokeSynchronousP95Ms,
      `${result.fixture} synchronous keystroke p95`,
    ).toBeLessThan(PERFORMANCE_BUDGET.keystrokeP95Ms);
  }
});
