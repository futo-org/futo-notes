// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { EDITOR_COMMANDS, filterCommands } from './commands';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, anchor: number): EditorView {
  const view = new EditorView({
    doc,
    selection: { anchor },
    extensions: [markdown()],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function run(id: string, view: EditorView): void {
  const cmd = EDITOR_COMMANDS.find((c) => c.id === id);
  if (!cmd) throw new Error(`command not found: ${id}`);
  cmd.run(view, view.state.selection.main.head);
}

describe('filterCommands', () => {
  it('returns all commands for empty query', () => {
    expect(filterCommands('').length).toBe(EDITOR_COMMANDS.length);
  });

  it('ranks prefix label matches highest', () => {
    const r = filterCommands('head');
    expect(r[0].id).toBe('heading-1');
    expect(r.slice(0, 3).map((c) => c.id)).toEqual(['heading-1', 'heading-2', 'heading-3']);
  });

  it('matches by keyword', () => {
    const r = filterCommands('todo');
    expect(r[0].id).toBe('task-list');
  });

  it('matches shorthand like h1', () => {
    const r = filterCommands('h1');
    expect(r[0].id).toBe('heading-1');
  });

  it('matches "table" to table command', () => {
    const r = filterCommands('table');
    expect(r[0].id).toBe('table');
  });

  it('is case-insensitive', () => {
    expect(filterCommands('TABLE')[0].id).toBe('table');
  });

  it('returns empty for no match', () => {
    expect(filterCommands('nonexistent-command-xyz')).toEqual([]);
  });
});

describe('EDITOR_COMMANDS.run', () => {
  it('heading-1 prepends # to the current line', () => {
    const v = setup('hello world', 0);
    run('heading-1', v);
    expect(v.state.doc.toString()).toBe('# hello world');
  });

  it('heading-2 replaces existing heading-1', () => {
    const v = setup('# hello', 3);
    run('heading-2', v);
    expect(v.state.doc.toString()).toBe('## hello');
  });

  it('paragraph strips heading prefix', () => {
    const v = setup('## hello', 4);
    run('paragraph', v);
    expect(v.state.doc.toString()).toBe('hello');
  });

  it('paragraph strips list prefix', () => {
    const v = setup('- item', 3);
    run('paragraph', v);
    expect(v.state.doc.toString()).toBe('item');
  });

  it('bullet-list adds dash prefix', () => {
    const v = setup('item', 0);
    run('bullet-list', v);
    expect(v.state.doc.toString()).toBe('- item');
  });

  it('quote adds > prefix', () => {
    const v = setup('note', 0);
    run('quote', v);
    expect(v.state.doc.toString()).toBe('> note');
  });

  it('divider replaces current line with --- and lands cursor past the blank line', () => {
    const v = setup('scratch', 0);
    run('divider', v);
    expect(v.state.doc.toString()).toBe('---\n\n');
    expect(v.state.selection.main.head).toBe(5); // after the second \n
  });

  it('table inserts a minimal 2-column table', () => {
    const v = setup('', 0);
    run('table', v);
    const doc = v.state.doc.toString();
    expect(doc).toContain('| Column 1 | Column 2 |');
    expect(doc).toContain('| --- | --- |');
  });

  it('code-block wraps current line in fences', () => {
    const v = setup('example', 0);
    run('code-block', v);
    expect(v.state.doc.toString()).toBe('```\nexample\n```');
  });

  it('code-block on empty line produces empty fence', () => {
    const v = setup('', 0);
    run('code-block', v);
    expect(v.state.doc.toString()).toBe('```\n\n```');
  });
});
