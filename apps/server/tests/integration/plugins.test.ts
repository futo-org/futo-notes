import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/index.js';
import { upsertNote, getNote } from '../../src/db/notes.js';
import { contentHash } from '../../src/sync/hash.js';
import { __setTestLlmResponder } from '../../src/plugins/llm.js';
import { authReq, createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';

async function waitForRunDetail(
  app: TestEnv['app'],
  token: string,
  runId: string,
): Promise<{ run: { status: string }; items: Array<Record<string, unknown>> }> {
  for (let i = 0; i < 40; i++) {
    const res = await authReq(app, 'GET', `/plugins/runs/${runId}`, token);
    if (res.status === 200) {
      const data = await res.json() as { run: { status: string }; items: Array<Record<string, unknown>> };
      if (data.run.status !== 'running') {
        return data;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

function seedNote(env: TestEnv, uuid: string, filename: string, content: string, modifiedAt = Date.now()): void {
  fs.mkdirSync(env.notesDir, { recursive: true });
  fs.writeFileSync(path.join(env.notesDir, filename), content, 'utf8');
  upsertNote(getDb(), uuid, filename, contentHash(content), modifiedAt);
}

describe('Plugins', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    __setTestLlmResponder(null);
  });

  afterEach(() => {
    __setTestLlmResponder(null);
    env.cleanup();
  });

  it('lists built-in automation status', async () => {
    const token = await setupAndLogin(env.app);
    const res = await authReq(env.app, 'GET', '/plugins/status', token);
    expect(res.status).toBe(200);

    const data = await res.json() as {
      plugins: Array<{ id: string; auto_apply: boolean; config_schema: Array<{ key: string }> }>;
      scheduler: { phase: string };
    };

    expect(data.scheduler.phase).toBe('idle');
    expect(data.plugins).toHaveLength(1);
    expect(data.plugins[0].id).toBe('untitled-no-more');
    expect(data.plugins[0].auto_apply).toBe(false);
    expect(data.plugins[0].config_schema.some((field) => field.key === 'maxContentChars')).toBe(true);
  });

  it('creates preview suggestions and applies approved rename with wikilink rewrite', async () => {
    const token = await setupAndLogin(env.app);
    __setTestLlmResponder(() => 'meeting notes');

    const oldMtime = Date.now() - (10 * 60 * 1000);
    seedNote(env, 'note-1', 'Untitled.md', 'Agenda for the team sync and follow-up action items.', oldMtime);
    seedNote(env, 'note-2', 'Reference.md', 'See [[Untitled]] before next week.', oldMtime);

    const runRes = await authReq(env.app, 'POST', '/plugins/untitled-no-more/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const preview = await waitForRunDetail(env.app, token, run_id);
    expect(preview.run.status).toBe('awaiting_approval');
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].status).toBe('suggested');
    expect(preview.items[0].preview).toMatchObject({
      oldTitle: 'Untitled',
      proposedTitle: 'meeting notes',
      rewriteExactWikiLinks: true,
    });

    const itemId = Number(preview.items[0].id);
    const approveRes = await authReq(env.app, 'POST', `/plugins/runs/${run_id}/items/${itemId}/approve`, token);
    expect(approveRes.status).toBe(200);

    const applyRes = await authReq(env.app, 'POST', `/plugins/runs/${run_id}/apply-approved`, token);
    expect(applyRes.status).toBe(200);

    const applied = await waitForRunDetail(env.app, token, run_id);
    expect(applied.run.status).toBe('succeeded');
    expect(applied.items[0].status).toBe('applied');

    const renamed = getNote(getDb(), 'note-1');
    expect(renamed?.filename).toBe('meeting notes.md');
    const referenceContent = fs.readFileSync(path.join(env.notesDir, 'Reference.md'), 'utf8');
    expect(referenceContent).toContain('[[meeting notes]]');
    expect(referenceContent).not.toContain('[[Untitled]]');
  });

  it('supports auto-apply runs via plugin config', async () => {
    const token = await setupAndLogin(env.app);
    __setTestLlmResponder(() => 'trip planning');

    const configRes = await authReq(env.app, 'POST', '/plugins/untitled-no-more/config', token, {
      auto_apply: true,
      schedule_kind: 'manual',
      config: {
        maxContentChars: 1500,
      },
    });
    expect(configRes.status).toBe(200);

    const oldMtime = Date.now() - (10 * 60 * 1000);
    seedNote(env, 'note-3', 'Untitled (2).md', 'Reservations, packing list, and places to visit.', oldMtime);

    const runRes = await authReq(env.app, 'POST', '/plugins/untitled-no-more/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const detail = await waitForRunDetail(env.app, token, run_id);
    expect(detail.run.status).toBe('succeeded');
    expect(detail.items[0].status).toBe('applied');

    const renamed = getNote(getDb(), 'note-3');
    expect(renamed?.filename).toBe('trip planning.md');
  });
});
