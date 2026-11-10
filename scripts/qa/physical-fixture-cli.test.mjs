import { expect, it } from 'vitest';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';

it('refuses extra arguments and arbitrary XCTest commands before loading a manifest', async () => {
  for (const args of [
    [],
    ['capture', '--test', 'arbitrary'],
    ['read', '--run', '../other'],
    ['capture', '--manifest', 'unused', '--device', 'foreign'],
  ]) {
    await expect(runPhysicalFixtureCLI(args)).rejects.toThrow(/physical-fixture/);
  }
});
