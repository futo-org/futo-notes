// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { mountEditor } from './puppetEditor.fixture';
import { runPuppetCommand } from './puppetInspector';
import './puppetInspector.fixture';

const run = (verb: string, args: Record<string, unknown> = {}) =>
  runPuppetCommand('do', { verb, args });

/** Each line as `kind|text`, as `doc` reads them. */
const lines = () =>
  (runPuppetCommand('doc', {}).body as { lines: Array<{ kind: string; text: string }> }).lines.map(
    (line) => `${line.kind}|${line.text}`,
  );

describe('convenience verbs: fast, and not input a person can produce', () => {
  it('actions marks the fast writes and ScrollToLine, and no other editor verb (ScrollBy: puppetScroll.test.ts)', async () => {
    await mountEditor();
    const body = runPuppetCommand('actions', {}).body as {
      actions: Array<{ name: string; convenience?: boolean }>;
    };
    const flagged = body.actions.filter((a) => a.convenience && a.name !== 'ScrollBy');
    expect(flagged.map((a) => a.name)).toEqual([
      'Insert',
      'Replace',
      'ReplaceLine',
      'InsertLine',
      'AppendLine',
      'ScrollToLine',
    ]);
    expect(body.actions.find((a) => a.name === 'Type')?.convenience).toBeUndefined();
  });

  it('read their text as markdown, past the keymap — no list continuation', async () => {
    const editor = await mountEditor('- [ ] coffee\n');
    expect(run('InsertLine', { afterLine: 1, text: '- [ ] tea' }).status).toBe(200);
    // Typed, the Enter would have made the task itself and this would read `- [ ] - [ ] tea`.
    expect(editor.markdown()).toBe('- [ ] coffee\n- [ ] tea\n');
    expect(run('ReplaceLine', { line: 2, text: '- [x] tea' }).status).toBe(200);
    // A write into the middle of a line keeps its edge spaces, which markdown would trim.
    expect(run('Insert', { after: 'coffee', text: ' beans' }).status).toBe(200);
    expect(run('Replace', { find: 'tea', text: 'milk' }).status).toBe(200);
    expect(editor.markdown()).toBe('- [ ] coffee beans\n- [x] milk\n');
  });

  it('InsertLine after a list item adds an item, and plain text becomes a plain one', async () => {
    const editor = await mountEditor('- [ ] coffee\n- [x] milk\n');
    expect(run('InsertLine', { afterLine: 1, text: 'bread' }).status).toBe(200);
    expect(editor.markdown()).toBe('- [ ] coffee\n- bread\n- [x] milk\n');
  });

  it('InsertLine after a typed line of a paragraph types another, with the same break', async () => {
    const editor = await mountEditor('one\ntwo\n');
    expect(run('InsertLine', { afterLine: 1, text: 'mid' }).status).toBe(200);
    expect(editor.markdown()).toBe('one\nmid\ntwo\n');
  });

  it('InsertLine of a block no item can start (a divider) puts it after the list', async () => {
    const editor = await mountEditor('- coffee\n- milk\n\nnext\n');
    expect(run('InsertLine', { afterLine: 2, text: '---' }).status).toBe(200);
    expect(lines().slice(0, 3)).toEqual(['bullet|coffee', 'bullet|milk', 'divider|']);
    expect(editor.markdown()).toMatch(/^- coffee\n- milk\n\n---\n\s*next\n$/);
  });

  it('ReplaceLine with a heading over a whole paragraph makes it one, as pasting does', async () => {
    const editor = await mountEditor('old\n\nkeep\n');
    expect(run('ReplaceLine', { line: 1, text: '## New' }).status).toBe(200);
    expect(editor.markdown()).toBe('## New\n\nkeep\n');
  });

  it('AppendLine adds a line of the editor per call, blanks included', async () => {
    // A line is a block: what Enter makes. The old rule filled the blank last line the
    // previous call had just made, so heading, blank, bullet came out as two lines.
    const runs: Array<[string[], string[]]> = [
      [
        ['# Week 38', '', '- shipped'],
        ['heading 1|Week 38', 'paragraph|', 'bullet|shipped'],
      ],
      [
        ['a', 'b', 'c'],
        ['paragraph|a', 'paragraph|b', 'paragraph|c'],
      ],
      [
        ['', 'x'],
        ['paragraph|', 'paragraph|x'],
      ],
      [
        ['a', '', '', 'b'],
        ['paragraph|a', 'paragraph|', 'paragraph|', 'paragraph|b'],
      ],
    ];
    for (const [texts, expected] of runs) {
      await mountEditor('');
      for (const text of texts) expect(run('AppendLine', { text }).status).toBe(200);
      // The editor keeps an empty open line after a list or a heading.
      expect(
        lines().filter((line, index, all) => index < all.length - 1 || line !== 'paragraph|'),
      ).toEqual(expected);
    }
  });

  it('AppendLine continues a list it lands beside, as markdown would read it', async () => {
    const editor = await mountEditor('');
    run('AppendLine', { text: '- a' });
    run('AppendLine', { text: '- b' });
    expect(editor.markdown()).toBe('- a\n- b\n');
  });

  it('a fast write is one undo step', async () => {
    const editor = await mountEditor('one\n');
    run('Insert', { after: 'one', text: ' **two**' });
    expect(editor.markdown()).toBe('one **two**\n');
    expect(run('Undo').status).toBe(200);
    expect(editor.markdown()).toBe('one\n');
  });

  it('refuses a line the note does not have', async () => {
    await mountEditor('one\n\ntwo\n');
    expect(run('ReplaceLine', { line: 9, text: 'x' })).toEqual({
      status: 400,
      body: { ok: false, error: 'line 9 is not in the note: `doc` numbers the lines on screen' },
    });
  });
});
