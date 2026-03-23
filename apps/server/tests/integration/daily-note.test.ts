import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/index.js';
import { upsertNote } from '../../src/db/notes.js';
import { contentHash } from '../../src/sync/hash.js';
import { __setTestLlmResponder } from '../../src/plugins/llm.js';
import { authReq, createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';

function todayString(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function seedNote(env: TestEnv, uuid: string, filename: string, content: string, modifiedAt = Date.now()): void {
  fs.mkdirSync(env.notesDir, { recursive: true });
  fs.writeFileSync(path.join(env.notesDir, filename), content, 'utf8');
  upsertNote(getDb(), uuid, filename, contentHash(content), modifiedAt);
}

async function waitForRunDetail(
  app: TestEnv['app'],
  token: string,
  runId: string,
): Promise<{ run: { status: string; error_message?: string | null }; items: Array<Record<string, unknown>> }> {
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

describe('Daily Note Plugin', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    __setTestLlmResponder(null);
  });

  afterEach(() => {
    __setTestLlmResponder(null);
    env.cleanup();
  });

  it('builds a user profile from recent notes and generates a daily note', async () => {
    const token = await setupAndLogin(env.app);
    let profileCalled = false;
    let generateCalled = false;

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        profileCalled = true;
        expect(input.disableThinking).toBe(true);
        return JSON.stringify({
          domains: ['software engineering'],
          activeProjects: ['notes app'],
          recurringThemes: ['productivity'],
          people: ['Alice'],
          writingStyle: 'concise and direct',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        generateCalled = true;
        expect(input.disableThinking).toBe(false);
        return `Good morning! Here's your briefing for ${todayString()}.\n\n## Recent Activity\n\nYou worked on the [[Project Plan]] recently.\n\n## Open Tasks\n\n- [ ] Review PR\n\n## Suggested Next Steps\n\n- [ ] Continue coding`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    const oldMtime = Date.now() - (2 * 60 * 60 * 1000);
    seedNote(env, 'proj-plan', 'Project Plan.md', 'This is the project plan for our notes app. Working with Alice on productivity features.', oldMtime);
    seedNote(env, 'meeting-notes', 'Meeting Notes.md', 'Discussed architecture and sprint goals with the team.', oldMtime - 3600000);

    const runRes = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const detail = await waitForRunDetail(env.app, token, run_id);
    expect(detail.run.status).toBe('succeeded');
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].status).toBe('applied');

    expect(profileCalled).toBe(true);
    expect(generateCalled).toBe(true);

    // Verify the daily note file was created
    const today = todayString();
    const dailyPath = path.join(env.notesDir, `${today}.md`);
    expect(fs.existsSync(dailyPath)).toBe(true);
    const content = fs.readFileSync(dailyPath, 'utf8');
    expect(content).toContain('briefing');
    expect(content).toContain('## Recent Activity');
    // Wikilink to a known note should be preserved
    expect(content).toContain('[[Project Plan]]');
  });

  it('skips profile building when no new notes exist', async () => {
    const token = await setupAndLogin(env.app);
    let profileCalled = false;

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        profileCalled = true;
        return JSON.stringify({
          domains: ['testing'],
          activeProjects: [],
          recurringThemes: [],
          people: [],
          writingStyle: 'terse',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        return `Daily briefing for ${todayString()}.\n\n## Recent Activity\n\nNothing new.\n\n## Open Tasks\n\nNone.\n\n## Suggested Next Steps\n\nRelax.`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    // First run: profile should be built (but no notes to profile)
    const runRes1 = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes1.status).toBe(202);
    const { run_id: runId1 } = await runRes1.json() as { run_id: string };
    const detail1 = await waitForRunDetail(env.app, token, runId1);
    expect(detail1.run.status).toBe('succeeded');

    // Profile should NOT have been called since there are no notes
    expect(profileCalled).toBe(false);
  });

  it('is idempotent — second run on same day skips generation', async () => {
    const token = await setupAndLogin(env.app);
    let generateCount = 0;

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        return JSON.stringify({
          domains: [],
          activeProjects: [],
          recurringThemes: [],
          people: [],
          writingStyle: '',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        generateCount++;
        return `Daily briefing.\n\n## Recent Activity\n\nTest.\n\n## Open Tasks\n\nNone.\n\n## Suggested Next Steps\n\nNone.`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    seedNote(env, 'some-note', 'Some Note.md', 'Content here for the daily note plugin.', Date.now() - 3600000);

    // First run
    const runRes1 = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes1.status).toBe(202);
    const { run_id: runId1 } = await runRes1.json() as { run_id: string };
    const detail1 = await waitForRunDetail(env.app, token, runId1);
    expect(detail1.run.status).toBe('succeeded');
    expect(detail1.items).toHaveLength(1);

    // Second run — should skip
    const runRes2 = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes2.status).toBe(202);
    const { run_id: runId2 } = await runRes2.json() as { run_id: string };
    const detail2 = await waitForRunDetail(env.app, token, runId2);
    expect(detail2.run.status).toBe('succeeded');
    expect(detail2.items).toHaveLength(0);

    expect(generateCount).toBe(1);
  });

  it('extracts open tasks from recent notes', async () => {
    const token = await setupAndLogin(env.app);

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        return JSON.stringify({
          domains: [],
          activeProjects: [],
          recurringThemes: [],
          people: [],
          writingStyle: '',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        // Verify open tasks are in the prompt
        expect(input.userPrompt).toContain('buy milk');
        expect(input.userPrompt).toContain('call dentist');
        return `Daily briefing.\n\n## Recent Activity\n\nTest.\n\n## Open Tasks\n\n- [ ] buy milk\n\n## Suggested Next Steps\n\nNone.`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    const oldMtime = Date.now() - (2 * 60 * 60 * 1000);
    seedNote(env, 'tasks-note', 'Tasks.md', '- [ ] buy milk\n- [x] done task\n- [ ] call dentist\n', oldMtime);

    const runRes = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const detail = await waitForRunDetail(env.app, token, run_id);
    expect(detail.run.status).toBe('succeeded');
  });

  it('strips invalid wikilinks from generated content', async () => {
    const token = await setupAndLogin(env.app);

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        return JSON.stringify({
          domains: [],
          activeProjects: [],
          recurringThemes: [],
          people: [],
          writingStyle: '',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        // Return content with a valid and an invalid wikilink
        return `Daily briefing.\n\n## Recent Activity\n\nSee [[Real Note]] and [[Nonexistent Note]].\n\n## Open Tasks\n\nNone.\n\n## Suggested Next Steps\n\nNone.`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    seedNote(env, 'real-note', 'Real Note.md', 'This is a real note.', Date.now() - 3600000);

    const runRes = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const detail = await waitForRunDetail(env.app, token, run_id);
    expect(detail.run.status).toBe('succeeded');

    const today = todayString();
    const content = fs.readFileSync(path.join(env.notesDir, `${today}.md`), 'utf8');
    // Valid wikilink should be preserved
    expect(content).toContain('[[Real Note]]');
    // Invalid wikilink should have brackets stripped
    expect(content).not.toContain('[[Nonexistent Note]]');
    expect(content).toContain('Nonexistent Note');
  });

  it('create_note change type works end-to-end via propose and apply', async () => {
    const token = await setupAndLogin(env.app);

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-generate') {
        return `Daily briefing.\n\n## Recent Activity\n\nTest.\n\n## Open Tasks\n\nNone.\n\n## Suggested Next Steps\n\nNone.`;
      }
      return '{}';
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: false,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    seedNote(env, 'context-note', 'Context.md', 'Some context for the daily note.', Date.now() - 3600000);

    const runRes = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };

    const preview = await waitForRunDetail(env.app, token, run_id);
    expect(preview.run.status).toBe('awaiting_approval');
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].change_type).toBe('create_note');

    // Approve and apply
    const itemId = Number(preview.items[0].id);
    const approveRes = await authReq(env.app, 'POST', `/plugins/runs/${run_id}/items/${itemId}/approve`, token);
    expect(approveRes.status).toBe(200);

    const applyRes = await authReq(env.app, 'POST', `/plugins/runs/${run_id}/apply-approved`, token);
    expect(applyRes.status).toBe(200);

    const applied = await waitForRunDetail(env.app, token, run_id);
    expect(applied.run.status).toBe('succeeded');
    expect(applied.items[0].status).toBe('applied');

    // Verify file was created
    const today = todayString();
    expect(fs.existsSync(path.join(env.notesDir, `${today}.md`))).toBe(true);
  });

  it('user profile is shared across plugins via getUserProfile/setUserProfile', async () => {
    const token = await setupAndLogin(env.app);

    __setTestLlmResponder((input) => {
      if (input.purpose === 'daily-note-profile') {
        return JSON.stringify({
          domains: ['engineering'],
          activeProjects: ['stonefruit'],
          recurringThemes: ['notes'],
          people: ['Bob'],
          writingStyle: 'casual',
        });
      }
      if (input.purpose === 'daily-note-generate') {
        return `Daily briefing.\n\n## Recent Activity\n\nTest.\n\n## Open Tasks\n\nNone.\n\n## Suggested Next Steps\n\nNone.`;
      }
      throw new Error(`Unexpected LLM purpose: ${input.purpose}`);
    });

    const configRes = await authReq(env.app, 'POST', '/plugins/daily-note/config', token, {
      enabled: true,
      auto_apply: true,
      schedule_kind: 'manual',
      config: {},
    });
    expect(configRes.status).toBe(200);

    seedNote(env, 'shared-note', 'Shared.md', 'Engineering work on stonefruit with Bob.', Date.now() - 3600000);

    const runRes = await authReq(env.app, 'POST', '/plugins/daily-note/run', token);
    expect(runRes.status).toBe(202);
    const { run_id } = await runRes.json() as { run_id: string };
    const detail = await waitForRunDetail(env.app, token, run_id);
    expect(detail.run.status).toBe('succeeded');

    // Verify the shared profile was stored in plugin_state with _shared plugin_id
    const row = getDb().prepare(
      `SELECT value_json FROM plugin_state WHERE plugin_id = '__shared__' AND state_key = 'user-profile'`,
    ).get() as { value_json: string } | undefined;
    expect(row).toBeDefined();
    const profile = JSON.parse(row!.value_json);
    expect(profile.domains).toContain('engineering');
    expect(profile.activeProjects).toContain('stonefruit');
  });
});
