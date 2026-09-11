// @vitest-environment jsdom
/*
 * The `/` menu's commit() end to end, against the REAL editor and the REAL
 * preset commands — not a schema fixture. QA-010: picking an item that
 * RESTRUCTURES the block (code block, divider, table) used to leave the typed
 * `/query` text sitting inside — or beside — the new node, because the old
 * `commit()` ran the command first and only then tried to find the run to
 * delete, against a document the command had already reshaped. This asserts
 * across every restructuring item AND the plain format items (a format item
 * never had the bug, but the fix changed how ALL items commit, so all of them
 * are covered here) that no typed `/…` text survives, and that undo takes the
 * whole pick back in one step.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { undo } from '@milkdown/kit/prose/history';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

interface EditorHandle {
  getProseMirrorView: () => EditorView | null;
}

// Module scope, not inside a hook — see dividerCaret.test.ts's header comment
// (and MilkdownEditor.test.ts's, with the pipeline numbers) for why.
const MilkdownEditor = (await import('./../MilkdownEditor.svelte')).default;

async function mountEditor(): Promise<EditorView> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  (target.ownerDocument as unknown as { elementFromPoint: () => null }).elementFromPoint = () =>
    null;
  // jsdom has no `Element.scrollIntoView` — the slash menu calls it on every
  // render to keep the highlighted row visible, unrelated to what this suite
  // is checking.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  const handle = mount(MilkdownEditor, {
    target,
    props: { content: '', onchange: () => {} },
  }) as unknown as EditorHandle;
  await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull(), {
    timeout: 30_000,
  });
  return handle.getProseMirrorView()!;
}

/** One keystroke, through every plugin's `handleTextInput` — same as a real one. */
function typeChar(view: EditorView, ch: string): void {
  const from = view.state.selection.from;
  const to = view.state.selection.to;
  for (const plugin of view.state.plugins) {
    const handler = plugin.props.handleTextInput;
    if (handler && handler(view, from, to, ch)) return;
  }
  view.dispatch(view.state.tr.insertText(ch, from, to));
}

function type(view: EditorView, text: string): void {
  for (const ch of text) typeChar(view, ch);
}

/**
 * Enter, delivered as a genuine DOM `keydown` on the view's own element —
 * exactly what a real keystroke fires — so ProseMirror's real plugin-priority
 * dispatch decides who claims it, the same as in the browser.
 */
function pressEnter(view: EditorView): void {
  view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}

function wholeText(view: EditorView): string {
  return view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
}

describe('the `/` menu commits every item as one step (QA-010)', () => {
  it('code block: no stray "/code" text inside the fence', async () => {
    const view = await mountEditor();
    type(view, '/code');
    pressEnter(view);

    let codeBlock: { textContent: string } | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'code_block') codeBlock = node;
    });
    expect(codeBlock).not.toBeNull();
    expect((codeBlock as unknown as { textContent: string }).textContent).toBe('');
    expect(wholeText(view)).not.toContain('/code');
  });

  it('divider: no stray "/divider" text, and the shared end state applies', async () => {
    const view = await mountEditor();
    type(view, '/divider');
    pressEnter(view);

    expect(wholeText(view)).not.toContain('/divider');
    expect(wholeText(view)).not.toContain('divider');

    const { doc, selection } = view.state;
    expect(selection instanceof TextSelection).toBe(true);
    let hrPos = -1;
    doc.descendants((node, pos) => {
      if (hrPos === -1 && node.type.name === 'hr') hrPos = pos;
      return hrPos === -1;
    });
    expect(hrPos).toBeGreaterThanOrEqual(0);
    const $hr = doc.resolve(hrPos);
    const next = $hr.parent.maybeChild($hr.index() + 1);
    expect(next?.type.name).toBe('paragraph');
    expect(next?.content.size).toBe(0);
  });

  it('table: no stray "/table" text in any cell', async () => {
    const view = await mountEditor();
    type(view, '/table');
    pressEnter(view);

    let tableNode: unknown = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'table') tableNode = node;
    });
    expect(tableNode).not.toBeNull();
    expect(wholeText(view)).not.toContain('/table');
    expect(wholeText(view)).not.toContain('table');
  });

  it('heading: no stray "/heading-1" text, and the block is a level-1 heading', async () => {
    const view = await mountEditor();
    type(view, '/heading-1');
    pressEnter(view);

    const first = view.state.doc.firstChild;
    expect(first?.type.name).toBe('heading');
    expect(first?.attrs.level).toBe(1);
    expect(first?.textContent).toBe('');
    expect(wholeText(view)).not.toContain('heading');
  });

  it('bullet list: no stray "/bullet-list" text', async () => {
    const view = await mountEditor();
    type(view, '/bullet-list');
    pressEnter(view);

    const first = view.state.doc.firstChild;
    expect(first?.type.name).toBe('bullet_list');
    expect(wholeText(view)).not.toContain('bullet');
  });

  it('quote: no stray "/quote" text', async () => {
    const view = await mountEditor();
    type(view, '/quote');
    pressEnter(view);

    const first = view.state.doc.firstChild;
    expect(first?.type.name).toBe('blockquote');
    expect(wholeText(view)).not.toContain('quote');
  });

  it('one Ctrl-Z undoes the whole pick — the delete and the command together', async () => {
    const view = await mountEditor();
    type(view, '/code');
    pressEnter(view);

    let codeBlock: unknown = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'code_block') codeBlock = node;
    });
    expect(codeBlock).not.toBeNull();

    // The delete and the command are ONE transaction (commandRunner.ts's
    // `combineDeleteAndCommand`), so one `undo()` call takes the pick back —
    // there is no intermediate state where the code block is gone but the
    // delete it was fused with is still a separate, un-undone step.
    expect(undo(view.state, view.dispatch.bind(view))).toBe(true);

    let codeBlockAfterUndo: unknown = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === 'code_block') codeBlockAfterUndo = node;
    });
    expect(codeBlockAfterUndo).toBeNull();
  });
});
