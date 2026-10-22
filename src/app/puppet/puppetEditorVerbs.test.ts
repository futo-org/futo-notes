// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { errorOf, run } from './puppetInspector.fixture';
import { runPuppetCommand } from './puppetInspector';

describe('typing, as the person at the keyboard does it', () => {
  it("Type goes through the editor's input rules, and a newline is the Enter key", async () => {
    const editor = await mountEditor('');
    expect(run('Type', { text: '# Week 38\n\n- shipped' }).status).toBe(200);
    // `# ` and `- ` are the editor's input rules; each Enter made a new block.
    expect(
      (runPuppetCommand('doc', {}).body as { lines: Array<{ kind: string; text: string }> }).lines
        .slice(0, 3)
        .map((line) => `${line.kind}|${line.text}`),
    ).toEqual(['heading 1|Week 38', 'paragraph|', 'bullet|shipped']);
    expect(editor.markdown()).toContain('- shipped');
  });

  it('Enter at the end of a task continues the list with an open task', async () => {
    const editor = await mountEditor('- [x] coffee\n- [x] tea\n');
    expect(run('PlaceCaret', { at: 9 }).status).toBe(200);
    expect(run('Type', { text: '\nsugar' }).status).toBe(200);
    expect(editor.markdown()).toBe('- [x] coffee\n- [ ] sugar\n- [x] tea\n');
  });

  it('Press takes the keys a keyboard has, with modifiers, "count" times', async () => {
    const editor = await mountEditor('abc\n');
    expect(run('PlaceCaret', { at: 4 }).status).toBe(200);
    expect(run('Press', { key: 'Backspace', count: 2 }).status).toBe(200);
    expect(editor.markdown()).toBe('a\n');
    expect(run('Press', { key: 'Home', count: 0 }).status).toBe(400);
    expect(run('Press', { key: 'Home' }).status).toBe(200);
    expect(editor.view.state.selection.head).toBe(1);
    expect(run('Press', { key: 'Shift-End' }).status).toBe(200);
    expect(editor.view.state.selection).toMatchObject({ from: 1, to: 2 });
    // The editor's own keymap: Mod-b is Bold.
    expect(run('Press', { key: 'Mod-b' }).status).toBe(200);
    expect(editor.markdown()).toBe('**a**\n');
    const refused = run('Press', { key: 'F13' });
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toContain('Backspace');
    expect(errorOf(run('Press', { key: 'Hyper-a' }))).toContain('no modifier key called "Hyper"');
  });

  it('an arrow collapses a selection to the side it points at, as the browser does', async () => {
    // Moving one further would leave the list item: Enter would then start a paragraph.
    const editor = await mountEditor('- [ ] coffee\n- [ ] tea\n');
    expect(run('Select', { find: 'tea' }).status).toBe(200);
    const tea = editor.view.state.selection;
    expect(run('Press', { key: 'ArrowRight' }).status).toBe(200);
    expect(editor.view.state.selection).toMatchObject({ anchor: tea.to, head: tea.to });
    expect(run('Type', { text: '\nsugar' }).status).toBe(200);
    expect(editor.markdown()).toBe('- [ ] coffee\n- [ ] tea\n- [ ] sugar\n');
    expect(run('Select', { find: 'coffee' }).status).toBe(200);
    const coffee = editor.view.state.selection;
    expect(run('Press', { key: 'ArrowLeft' }).status).toBe(200);
    expect(editor.view.state.selection).toMatchObject({ anchor: coffee.from, head: coffee.from });
  });

  it('Undo steps back through what was typed', async () => {
    const editor = await mountEditor('one\n');
    run('PlaceCaret', { at: 4 });
    run('Type', { text: ' two' });
    expect(editor.markdown()).toBe('one two\n');
    expect(run('Undo').status).toBe(200);
    expect(editor.markdown()).toBe('one\n');
    expect(run('Undo').status).toBe(409);
  });
});

describe('blocks', () => {
  it('ToggleTask ticks and unticks the box on a line, as tapping it does', async () => {
    const editor = await mountEditor('- [ ] coffee\n- [x] tea\n\nplain\n');
    expect(run('ToggleTask', { line: 1 }).status).toBe(200);
    expect(run('ToggleTask', { line: 2 }).status).toBe(200);
    expect(editor.markdown()).toBe('- [x] coffee\n- [ ] tea\n\nplain\n');
    const notATask = run('ToggleTask', { line: 3 });
    expect(notATask.status).toBe(409);
    expect(errorOf(notATask)).toContain('not a task');
    expect(run('ToggleTask', { line: 9 }).status).toBe(400);
  });

  it('ToggleTask refuses a line with no box: code, or a bullet nested in a task', async () => {
    const editor = await mountEditor('```taskpaper\nx\n```\n\n- [ ] parent\n  - child\n');
    expect(run('ToggleTask', { line: 1 }).status).toBe(409);
    expect(run('ToggleTask', { line: 3 }).status).toBe(409);
    expect(editor.markdown()).toContain('- [ ] parent');
  });

  it('a line under a task item continues it, with no box of its own', async () => {
    await mountEditor('- [ ] milk\n  eggs\n');
    const { lines } = runPuppetCommand('doc', {}).body as { lines: Array<Record<string, unknown>> };
    expect(lines.slice(0, 2).map((line) => [line.kind, line.text])).toEqual([
      ['task ☐', 'milk'],
      ['paragraph', 'eggs'],
    ]);
    expect(errorOf(run('ToggleTask', { line: 2 }))).toBe('line 2 is not a task (paragraph): eggs');
  });

  it('ScrollToLine brings the line itself on screen, deep in a code block too', async () => {
    const code = Array.from({ length: 30 }, (_, i) => `code ${i + 1}`).join('\n');
    const { view } = await mountEditor(`top\n\n\`\`\`\n${code}\n\`\`\`\n`);
    layOutLines(view, { rows: 5 });
    const onScreen = () =>
      (runPuppetCommand('state', {}).body as { editor: { onScreen: unknown } }).editor.onScreen;
    expect(run('ScrollToLine', { line: 26 }).status).toBeLessThan(300);
    expect(onScreen()).toEqual({ first: 24, last: 28 });
    // A scroller that cannot move: the verb says so, never OK for a line still off screen.
    Object.defineProperty(view.dom.parentElement!, 'scrollTop', { get: () => 23, set: () => {} });
    const { action } = run('ScrollToLine', { line: 2 }).body as { action: number };
    await vi.waitFor(() =>
      expect(runPuppetCommand('diff', { action }).body).toMatchObject({
        status: 409,
        result: { error: 'line 2 does not come on screen (lines 24–28 show)' },
      }),
    );
  });

  describe('ScrollToLine on a scroller the platform moves too (iOS)', () => {
    const settled = async (reply: { body: unknown }) => {
      const { action } = reply.body as { action: number };
      let record: { pending?: boolean; status?: number; result?: { error?: string } } = {};
      await vi.waitFor(() => {
        record = runPuppetCommand('diff', { action }).body as typeof record;
        expect(record.pending).toBeUndefined();
      });
      return record;
    };
    const onScreen = () =>
      (runPuppetCommand('state', {}).body as { editor: { onScreen: unknown } }).editor.onScreen;

    it('refuses once something scrolled the line back off screen before it answered', async () => {
      const { view } = await mountEditor(
        `${Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n\n')}\n`,
      );
      layOutLines(view, { rows: 5 });
      const scroller = view.dom.parentElement!;
      const reply = run('ScrollToLine', { line: 26 });
      expect(reply.status).toBe(202);
      // The browser fires `scroll`, then a resize's caret reveal takes the view back to the caret.
      scroller.dispatchEvent(new Event('scroll'));
      scroller.scrollTop = 0;
      const record = await settled(reply);
      expect(record.status).toBe(409);
      expect(record.result?.error).toBe('line 26 does not come on screen (lines 1–5 show)');
    });

    it('goes to a place rather than by a distance, which a stale copy of the offset would add to', async () => {
      const { view } = await mountEditor(
        `${Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n\n')}\n`,
      );
      layOutLines(view, { rows: 5 });
      const scroller = view.dom.parentElement!;
      // WebKit on iOS applies a relative scroll to its own copy of the offset, which the
      // page's later moves have not reached: a second ScrollToLine landed twice as far.
      let copy = scroller.scrollTop;
      scroller.scrollBy = ((options: ScrollToOptions) => {
        copy += options.top ?? 0;
        scroller.scrollTop = copy;
      }) as typeof scroller.scrollBy;
      for (const reveal of [true, false]) {
        const reply = run('ScrollToLine', { line: 26 });
        scroller.dispatchEvent(new Event('scroll'));
        expect((await settled(reply)).status).toBe(200);
        expect(onScreen()).toEqual({ first: 24, last: 28 });
        if (reveal) scroller.scrollTop = 0;
      }
    });
  });

  it("a table's grips open for a cell line on screen, by the line rule", async () => {
    const { view } = await mountEditor('intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend\n');
    layOutLines(view, { rows: 3 });
    view.dom.querySelector('table')!.getBoundingClientRect = () => new DOMRect(0, 1, 800, 4);
    expect(run('OpenTableRowMenu', { line: 4 })).toMatchObject({
      status: 409,
      body: { reach: [['ScrollToLine', { line: 4 }]] },
    });
    expect(run('OpenTableRowMenu', { line: 99 }).status).toBe(400);
    expect(errorOf(run('OpenTableRowMenu', { line: 1 }))).toContain('not a table cell');
    expect(run('OpenTableRowMenu', { line: 2 }).status).toBe(200);
  });

  it('MoveBlock drops the top-level block a line is in beside another, a list whole', async () => {
    const editor = await mountEditor('- a\n- b\n- c\n\none\n\ntwo\n');
    expect(run('MoveBlock', { line: 2, after: 4 }).status).toBe(200);
    expect(editor.markdown()).toBe('one\n\n- a\n- b\n- c\n\ntwo\n');
    expect(run('MoveBlock', { line: 5, before: 1 }).status).toBe(200);
    expect(editor.markdown()).toBe('two\n\none\n\n- a\n- b\n- c\n');
    expect(run('MoveBlock', { line: 3, after: 4 }).status).toBe(409);
    expect(run('MoveBlock', { line: 1, before: 1 }).status).toBe(409);
    expect(run('MoveBlock', { line: 1 }).status).toBe(400);
  });

  it('OpenLink is a click on a wikilink chip or a link', async () => {
    const editor = await mountEditor('See [[Lease plan]] and [site](https://example.com).\n');
    expect(run('OpenLink', { find: 'Lease plan' }).status).toBe(200);
    expect(run('OpenLink', { find: 'site', newTab: true }).status).toBe(200);
    expect(editor.openedNotes).toEqual([
      { title: 'Lease plan', gesture: expect.objectContaining({ button: 0 }) },
    ]);
    expect(editor.openedUrls).toEqual(['https://example.com']);
    expect(run('OpenLink', { at: 1 }).status).toBe(409);
  });
});

describe('the puppet clipboard', () => {
  it("Copy and Paste go through the editor's own copy handler and paste pipeline", async () => {
    const editor = await mountEditor();
    expect(run('Copy')).toMatchObject({ status: 409 });
    expect(run('Select', { find: 'brown' }).status).toBe(200);
    expect(run('Copy').status).toBe(200);
    expect(
      (runPuppetCommand('state', {}).body as { editor: { clipboard: string } }).editor.clipboard,
    ).toBe('brown');
    expect(run('PlaceCaret', { at: 1 }).status).toBe(200);
    expect(run('Paste').status).toBe(200);
    expect(editor.markdown()).toBe('brownthe quick brown fox\n\nsecond line\n');
    expect(run('Select', { find: 'brownthe ' }).status).toBe(200);
    expect(run('Cut').status).toBe(200);
    expect(editor.markdown()).toBe('quick brown fox\n\nsecond line\n');
  });

  it("state carries the clipboard cut as the selection's text is; clipboard reads it whole", async () => {
    await mountEditor();
    const long = 'x'.repeat(100);
    runPuppetCommand('clipboard', { text: long });
    expect(
      (runPuppetCommand('state', {}).body as { editor: { clipboard: string } }).editor.clipboard,
    ).toBe(`${'x'.repeat(80)}…`);
    expect(runPuppetCommand('clipboard', {}).body).toEqual({ clipboard: { text: long, html: '' } });
  });

  it('clipboard reports what it holds, takes outside text, and clears on request', async () => {
    const editor = await mountEditor('x\n');
    expect(runPuppetCommand('clipboard', { text: '**bold**' }).body).toEqual({
      clipboard: { text: '**bold**', html: '' },
    });
    run('PlaceCaret', { at: 2 });
    expect(run('Paste').status).toBe(200);
    // Markdown from outside is read as markdown.
    expect(editor.markdown()).toBe('x**bold**\n');
    expect(runPuppetCommand('clipboard', { clear: true }).body).toEqual({ clipboard: null });
    expect(run('Paste').status).toBe(409);
  });
});
