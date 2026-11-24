// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { errorOf, run } from './puppetInspector.fixture';
import { runPuppetCommand, runPuppetCommandJson } from './puppetInspector';
import { puppetVerb, registerPuppetShell, registerPuppetVerbs } from './puppetRegistry';

describe('actions', () => {
  it('offers no editor verbs when no editor is mounted, only the page-wide scroll', () => {
    const body = runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> };
    expect(body.actions.map((a) => a.name)).toEqual(['ScrollBy']);
  });
});

describe('do', () => {
  it('validates arguments against the schema before running', () => {
    registerPuppetVerbs(() => [
      puppetVerb('Type', { text: 'string' }, () => {}),
      puppetVerb('Select', { from: 'integer?', to: 'integer?', find: 'string?' }, () => {}),
    ]);
    // Every argument refusal ends with what this verb does accept: a guessed
    // name otherwise costs a round trip through `actions` to learn it.
    expect(runPuppetCommand('do', { verb: 'Type', args: {} })).toEqual({
      status: 400,
      body: {
        ok: false,
        error: 'Type: missing required argument "text" — takes {text: string}',
      },
    });
    expect(errorOf(run('Select', { from: '10', to: 15 }))).toMatch(
      /Select: argument "from" must be integer — takes \{.*from\?: integer/,
    );
    expect(errorOf(run('Select', { from: 10, to: 15, bogus: 1 }))).toContain(
      'Select: unknown argument "bogus" — takes {',
    );
    expect(runPuppetCommand('do', { verb: 'Nope' }).status).toBe(404);
  });

  it('refuses a read with no editor: 409 on a screen without one, 503 while a note mounts it', () => {
    registerPuppetShell({ screen: () => 'home', state: () => ({}) });
    expect(run('Select', { from: 0, to: 1 }).status).toBe(404);
    expect(runPuppetCommand('doc', {}).status).toBe(409);
    registerPuppetShell({ screen: () => 'editor:welcome', state: () => ({}) });
    expect(runPuppetCommand('doc', {}).status).toBe(503);
  });
});

describe('wire form', () => {
  it('search answers the app search ranking over the wire, awaited', async () => {
    const run = async (args: Record<string, unknown>) =>
      JSON.parse(await runPuppetCommandJson('search', JSON.stringify(args))) as {
        status: number;
        body: { query?: string; hits?: string[]; error?: string };
      };
    expect((await run({ query: 'landlord' })).status).toBe(501);
    const asked: Array<[string, number]> = [];
    registerPuppetShell({
      screen: () => 'home',
      state: () => ({}),
      search: async (query, limit) => {
        asked.push([query, limit]);
        return ['personal/home/lease notes', 'personal/home/apartment move checklist'];
      },
    });
    expect(await run({ query: 'landlord' })).toEqual({
      status: 200,
      body: {
        query: 'landlord',
        hits: ['personal/home/lease notes', 'personal/home/apartment move checklist'],
      },
    });
    await run({ query: 'landlord', limit: 3 });
    expect(asked).toEqual([
      ['landlord', 10],
      ['landlord', 3],
    ]);
    expect((await run({ query: '  ' })).status).toBe(400);
    expect((await run({ query: 'x', limit: 0 })).status).toBe(400);
    // Every other command still answers synchronously, as the phones' hosts need.
    expect(typeof runPuppetCommandJson('notes', '{}')).toBe('string');
  });

  it('file saves the open note first, then reads the disk; refused while an edit is unsaved', async () => {
    const run = async (args: Record<string, unknown>) =>
      JSON.parse(await runPuppetCommandJson('file', JSON.stringify(args))) as {
        status: number;
        body: { noteId?: string; text?: string; error?: string };
      };
    expect((await run({ noteId: 'work/retro' })).status).toBe(501);
    const disk = new Map([['work/retro', '# Retro\n']]);
    const steps: string[] = [];
    let unsaved: string[] = [];
    registerPuppetShell({
      screen: () => 'editor:work/retro',
      state: () => ({}),
      saveOpenNote: async () => {
        steps.push('save');
        return unsaved;
      },
      readNote: async (noteId) => {
        steps.push(`read ${noteId}`);
        return disk.get(noteId) ?? null;
      },
    });
    expect(await run({ noteId: 'work/retro' })).toEqual({
      status: 200,
      body: { noteId: 'work/retro', text: '# Retro\n' },
    });
    expect(steps).toEqual(['save', 'read work/retro']);
    expect((await run({ noteId: 'gone' })).status).toBe(404);
    unsaved = ['work/retro'];
    expect((await run({ noteId: 'work/retro' })).status).toBe(409);
    // Without saving: the disk as it is, the save never asked for.
    steps.length = 0;
    expect(await run({ noteId: 'work/retro', save: false })).toEqual({
      status: 200,
      body: { noteId: 'work/retro', text: '# Retro\n' },
    });
    expect(steps).toEqual(['read work/retro']);
    // Another note's failed save does not stand between the agent and this one.
    expect((await run({ noteId: 'gone' })).status).toBe(404);
    expect((await run({})).status).toBe(400);
  });

  it('takes JSON text and returns JSON text', () => {
    expect(JSON.parse(runPuppetCommandJson('actions', ''))).toMatchObject({
      status: 200,
      body: { screen: 'unknown', actions: [{ name: 'ScrollBy' }] },
    });
    expect(JSON.parse(runPuppetCommandJson('actions', '{nope'))).toEqual({
      status: 400,
      body: { ok: false, error: 'actions: arguments are not valid JSON' },
    });
    expect(JSON.parse(runPuppetCommandJson('bogus', '{}')).status).toBe(404);
  });
});

describe('what the eval sweep taught', () => {
  it('a verb that returns its own value still receipts as ok (GoHome returned its tab)', () => {
    registerPuppetVerbs(() => [
      puppetVerb('GoHome', {}, () => ({ id: 'tab-1', noteId: null }) as unknown as undefined),
    ]);
    const done = runPuppetCommand('do', { verb: 'GoHome', args: {} });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, verb: 'GoHome' });
  });

  it('sidebar rows carry the note id or folder path a verb takes', () => {
    const row = document.createElement('button');
    row.textContent = 'standup';
    row.setAttribute('data-note-id', 'work/standup');
    row.getBoundingClientRect = () => new DOMRect(8, 348, 263, 48);
    const folder = document.createElement('button');
    folder.textContent = 'work';
    folder.setAttribute('data-folder-path', 'work');
    folder.getBoundingClientRect = () => new DOMRect(8, 300, 263, 48);
    document.body.append(row, folder);
    const rows = (
      runPuppetCommand('elements', {}).body as { elements: Array<Record<string, unknown>> }
    ).elements;
    expect(rows.map((r) => [r.text, r.note, r.folder])).toEqual([
      ['standup', 'work/standup', undefined],
      ['work', undefined, 'work'],
    ]);
  });
});
