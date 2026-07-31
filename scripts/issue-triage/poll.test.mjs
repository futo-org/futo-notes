import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPoll } from './poll.mjs';
import { loadState, saveState, updateState } from './triageState.mjs';

describe('runPoll state coordination', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-poll-'));
    saveState(
      {
        watermark: '2026-07-30T00:00:00Z',
        issues: {
          8: {
            status: 'queued',
            classifiedAs: 'bug',
            title: 'Existing bug',
          },
        },
      },
      dir,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves a tier-2 transition while recording a newly posted issue', async () => {
    const issue = {
      number: 9,
      title: 'How do I export notes?',
      body: '',
      author: 'reporter',
      url: 'https://github.com/futo-org/futo-notes/issues/9',
      createdAt: '2026-07-31T00:00:00Z',
      updatedAt: '2026-07-31T00:01:00Z',
    };

    await runPoll({
      dryRun: false,
      stateDirectory: dir,
      dependencies: {
        fetchIssuesSince: async () => [issue],
        postAlert: async () => {
          await updateState((state) => {
            state.issues['8'].status = 'reproducing';
          }, dir);
          return { id: 123 };
        },
      },
    });

    expect(loadState(dir)).toMatchObject({
      watermark: '2026-07-31T00:01:00Z',
      issues: {
        8: { status: 'reproducing' },
        9: { status: 'posted', zulipMessageId: 123 },
      },
    });
  });
});
