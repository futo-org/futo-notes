// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { openFind } from '../../features/editor/milkdown/find/findPlugin';
import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { errorOf, run } from './puppetInspector.fixture';
import { refOf } from './puppetElements';
import { runPuppetCommand, runPuppetCommandJson } from './puppetInspector';
import { docVersionOf } from './puppetText';
import { puppetVerb, registerPuppetShell, registerPuppetVerbs } from './puppetRegistry';

describe('actions', () => {
  it("lists the screen's verbs and the editor's, with JSON Schema and no prose", async () => {
    await mountEditor();
    registerPuppetShell({
      screen: () => 'editor:brown fox',
      state: () => ({ note: { id: 'brown fox' } }),
    });
    registerPuppetVerbs(() => [puppetVerb('OpenNote', { noteId: 'string' }, () => {})]);
    const body = runPuppetCommand('actions', {}).body as {
      screen: string;
      actions: Array<{ name: string; schema: unknown }>;
    };
    expect(body.screen).toBe('editor:brown fox');
    const names = body.actions.map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'OpenNote',
        'Select',
        'Type',
        'Press',
        'Insert',
        'Bold',
        'Undo',
        'OpenFind',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(body.actions.find((a) => a.name === 'Select')!.schema).toEqual({
      type: 'object',
      properties: {
        from: { type: 'integer' },
        to: { type: 'integer' },
        find: { type: 'string' },
        expect: { type: 'string' },
        docVersion: { type: 'integer' },
      },
      required: [],
    });
    for (const action of body.actions) expect(action).not.toHaveProperty('description');
  });

  it('offers OpenFind while the bar is closed, and leaves the open bar to its own verbs', async () => {
    const { view } = await mountEditor();
    registerPuppetShell({ screen: () => 'editor:brown fox', state: () => ({}) });
    const names = () =>
      (runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> }).actions
        .map((a) => a.name)
        .filter((name) => name.includes('Find'));
    expect(names()).toEqual(['OpenFind']);
    // FindPanel.svelte registers SetFindQuery, StepFind and CloseFind while it is mounted.
    openFind(view);
    expect(names()).toEqual([]);
  });

  it('leaves find to the native bar in the phones embed, which has no shell', async () => {
    await mountEditor();
    const body = runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> };
    expect(body.actions.map((a) => a.name).filter((name) => name.includes('Find'))).toEqual([]);
  });

  it('offers no editor verbs when no editor is mounted, only the page-wide scroll', () => {
    const body = runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> };
    expect(body.actions.map((a) => a.name)).toEqual(['ScrollBy']);
  });
});

describe('do', () => {
  it('validates arguments against the schema before running', async () => {
    await mountEditor();
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

  it('Select by positions, then a formatting verb acts on that selection', async () => {
    const editor = await mountEditor();
    // `the quick brown fox` is the first paragraph: its text starts at position 1.
    const selected = run('Select', { from: 11, to: 16, expect: 'brown' });
    expect(selected.status).toBe(200);
    const receipt = selected.body as {
      editor: { selection: Record<string, unknown>; focused: boolean };
    };
    expect(receipt.editor.selection).toMatchObject({
      from: 11,
      to: 16,
      text: 'brown',
      line: 1,
      col: 16,
      formats: [],
    });
    expect(receipt.editor.focused).toBe(true);

    const bolded = run('Bold');
    expect(bolded.status).toBe(200);
    expect(editor.markdown()).toBe('the quick **brown** fox\n\nsecond line\n');
    // The toolbar's own reading of the selection now.
    expect(
      (bolded.body as { editor: { selection: { formats: string[] } } }).editor.selection.formats,
    ).toEqual(['bold']);
  });

  it('refuses Select when expect, docVersion or the range disagree with the document', async () => {
    const { view } = await mountEditor();
    expect(run('Select', { from: 11, to: 16, expect: 'quick' })).toEqual({
      status: 409,
      body: { ok: false, error: 'text at 11-16 is "brown", expected "quick"' },
    });
    const refused = run('Select', { from: 1, to: 4, docVersion: 12345 });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toBe(
      `document changed: docVersion is now ${docVersionOf(view.state.doc)}`,
    );
    expect(run('Select', { from: 0, to: 999 }).status).toBe(400);
    // Between the two paragraphs is no line: no caret goes there.
    expect(errorOf(run('PlaceCaret', { at: 21 }))).toContain('between blocks');
  });

  /**
   * A position is true for one version of the document; the text it names stays
   * true across every edit. A run that reused positions after an edit formatted
   * the wrong word and got a 200 for it.
   */
  it('Select, Replace and Insert take the text itself instead of a position', async () => {
    const editor = await mountEditor();
    const selected = run('Select', { find: 'brown' });
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({ selected: { from: 11, to: 16, text: 'brown' } });

    // Replacing text is selecting it and typing over it, which is what a person does.
    expect(run('Select', { find: 'second line' }).status).toBe(200);
    expect(run('Type', { text: 'last line' }).status).toBe(200);
    expect(editor.markdown()).toBe('the quick brown fox\n\nlast line\n');
  });

  it('an anchor that is absent or ambiguous refuses with every match, never a guess', async () => {
    await mountEditor('a b a\n');
    const missing = run('Select', { find: 'zzz' });
    expect(missing.status).toBe(409);
    expect(errorOf(missing)).toContain('no occurrence of "zzz"');

    const ambiguous = run('Select', { find: 'a' });
    expect(ambiguous.status).toBe(409);
    expect(errorOf(ambiguous)).toBe(
      '2 occurrences of "a" on screen (at 1, 5) — extend "find" until it is unique, or pass the positions you mean',
    );

    expect(run('Select', { find: 'b', from: 2, to: 3 }).status).toBe(400);
    expect(run('Select', {}).status).toBe(400);
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

  it('text off screen is refused with the way to it', async () => {
    const { view } = await mountEditor('the quick brown fox\n\nsecond line\n\nthird line\n');
    layOutLines(view, { rows: 1 });
    expect(run('Select', { find: 'third' })).toMatchObject({
      status: 409,
      body: { reach: [['ScrollToLine', { line: 3 }]] },
    });
    registerPuppetShell({ screen: () => 'editor:fox', state: () => ({}) });
    expect(run('PlaceCaret', { at: 30 })).toMatchObject({
      status: 409,
      body: { reach: [['ScrollToLine', { line: 2 }]] },
    });
    expect(runPuppetCommand('show', { text: 'third' }).status).toBe(409);
    // Home keeps the editor mounted, and nothing of it shows.
    registerPuppetShell({ screen: () => 'home', state: () => ({}) });
    expect(runPuppetCommand('show', { text: 'quick' }).status).toBe(409);
  });
});

describe('an element inside the note', () => {
  it('reads as only its lines on screen: a code block taller than it, a link off it', async () => {
    const code = Array.from({ length: 30 }, (_, i) => `code ${i + 1}`).join('\n');
    const { view } = await mountEditor(
      `[farlink](https://example.com)\n\n\`\`\`\n${code}\n\`\`\`\n`,
    );
    const textOf = (element: Element) =>
      (runPuppetCommand('show', { ref: refOf(element) }).body as { text: string }).text;
    const pre = view.dom.querySelector('pre')!;
    const link = view.dom.querySelector('a')!;
    // Line 1 is the link's paragraph, and code line N is line N + 1.
    layOutLines(view, { first: 12, rows: 5 });
    expect(textOf(pre)).toBe('code 11 code 12 code 13…');
    expect(textOf(link)).toBe('');
    expect(JSON.stringify(runPuppetCommand('observe', {}).body)).not.toContain('farlink');
    layOutLines(view);
    expect(textOf(link)).toBe('farlink');
  });
});
