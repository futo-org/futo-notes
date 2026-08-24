import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { Cm6GauntletAdapter } from './cm6Adapter';

interface SeedArgument {
  id: string;
  body: string;
}

function recordingPage(evidence: {
  seedIds: string[];
  waitedDocuments: string[];
  selections: Array<{ anchor: number; head: number }>;
}): Page {
  const page = {
    on: () => page,
    goto: async () => null,
    waitForLoadState: async () => {},
    waitForSelector: async () => null,
    waitForFunction: async (_callback: unknown, argument?: unknown) => {
      if (typeof argument === 'string') evidence.waitedDocuments.push(argument);
    },
    evaluate: async (_callback: unknown, argument?: unknown) => {
      if (
        typeof argument === 'object' &&
        argument !== null &&
        'id' in argument &&
        'body' in argument
      ) {
        evidence.seedIds.push((argument as SeedArgument).id);
      } else if (
        typeof argument === 'object' &&
        argument !== null &&
        'anchor' in argument &&
        'head' in argument
      ) {
        evidence.selections.push(argument as { anchor: number; head: number });
      }
    },
  };
  return page as unknown as Page;
}

describe('Cm6GauntletAdapter', () => {
  it('reuses one persisted scratch note across cases', async () => {
    const evidence = { seedIds: [], waitedDocuments: [], selections: [] };
    const adapter = new Cm6GauntletAdapter(recordingPage(evidence));

    await adapter.open('first source', 'foreign-1-block-0');
    await adapter.open('second source', 'foreign-2-block-9');

    expect(evidence.seedIds).toEqual(['editor-gauntlet-active', 'editor-gauntlet-active']);
    expect(new Set(evidence.seedIds).size).toBe(1);
  });

  it('maps raw CRLF offsets into the normalized CM6 document without changing the raw oracle', async () => {
    const evidence = { seedIds: [], waitedDocuments: [], selections: [] };
    const adapter = new Cm6GauntletAdapter(recordingPage(evidence));

    await adapter.open('a\r\nb\r\nc', 'foreign-crlf');
    await adapter.select({ anchor: 3, head: 7 });

    expect(evidence.waitedDocuments.at(-1)).toBe('a\nb\nc');
    expect(evidence.selections).toEqual([{ anchor: 2, head: 5 }]);
  });
});
