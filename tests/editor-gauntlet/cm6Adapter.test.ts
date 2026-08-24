import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { Cm6GauntletAdapter } from './cm6Adapter';

interface SeedArgument {
  id: string;
  body: string;
}

function pageRecordingSeedIds(ids: string[]): Page {
  const page = {
    on: () => page,
    goto: async () => null,
    waitForLoadState: async () => {},
    waitForSelector: async () => null,
    waitForFunction: async () => {},
    evaluate: async (_callback: unknown, argument?: unknown) => {
      if (
        typeof argument === 'object' &&
        argument !== null &&
        'id' in argument &&
        'body' in argument
      ) {
        ids.push((argument as SeedArgument).id);
      }
    },
  };
  return page as unknown as Page;
}

describe('Cm6GauntletAdapter', () => {
  it('reuses one persisted scratch note across cases', async () => {
    const seedIds: string[] = [];
    const adapter = new Cm6GauntletAdapter(pageRecordingSeedIds(seedIds));

    await adapter.open('first source', 'foreign-1-block-0');
    await adapter.open('second source', 'foreign-2-block-9');

    expect(seedIds).toEqual(['editor-gauntlet-active', 'editor-gauntlet-active']);
    expect(new Set(seedIds).size).toBe(1);
  });
});
