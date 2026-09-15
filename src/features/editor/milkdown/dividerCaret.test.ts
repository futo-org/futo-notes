// @vitest-environment jsdom
/*
 * QA-013's and QA-018's shared end state, pinned per starting state: typing
 * `---` (the markdown input rule) leaves the caret in a single empty
 * paragraph immediately below the rule. No leading blank line, no trailing
 * blank line beyond that one paragraph, no NodeSelection sitting on the hr
 * itself (the thing QA-018's scroll jump was actually caused by — a
 * NodeSelection is what a browser's native "scroll selection into view"
 * reacts to).
 *
 * Mounts the REAL editor (real `@milkdown/preset-commonmark` input rule, real
 * `dividerCaretFix` plugin) rather than a schema fixture: the bug this locks
 * was found by driving the upstream command directly and comparing what it
 * actually produces across starting states, and a fixture schema could assert
 * a shape without ever exercising the commands that are the real source of
 * the defect. The `/divider` slash item's end state is covered end to end in
 * `slash/index.test.ts` (it goes through this SAME plugin, not a second code
 * path).
 *
 * "Typing" goes through every plugin's `handleTextInput` prop exactly the way
 * a real keystroke does — `tr.insertText` bypasses `prosemirror-inputrules`
 * entirely and the `---` rule never fires.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

interface EditorHandle {
  getProseMirrorView: () => EditorView | null;
}

/**
 * The load-only surface used by the regression suite below: `openNote`/
 * `getContent` are what the shell actually calls to open a note (never the
 * mount-time `content` prop — see `src/editor-embed/createFutoEditorApi.ts`),
 * and `censusLoad` is the only way to force the chunked/progressive path on a
 * note this small (it takes explicit `MarkdownChunkOptions` rather than the
 * 400-line production default).
 */
interface LoadableEditorHandle extends EditorHandle {
  openNote: (text: string) => void;
  getContent: () => string | undefined;
  censusLoad: (
    text: string,
    chunkOptions: { minLines?: number; firstChunkLines?: number; chunkLines?: number },
  ) => { markdown: string | null; chunked: boolean; chunks: number; aborted: boolean };
}

// Imported at module scope, not inside a hook — pulling in the whole
// Milkdown/ProseMirror graph is expensive exactly once either way, but inside
// `beforeEach` it is charged to that hook's own timeout instead of collection
// (MilkdownEditor.test.ts's header comment has the pipeline numbers).
const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;

async function mountEditorHandle(content = ''): Promise<LoadableEditorHandle> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  // jsdom has no `elementFromPoint`; `@milkdown/plugin-block`'s mousemove path
  // calls it on mount even with no pointer activity in this test. Stubbed so
  // it doesn't throw — unrelated to what this suite is checking.
  (target.ownerDocument as unknown as { elementFromPoint: () => null }).elementFromPoint = () =>
    null;
  const handle = mount(MilkdownEditor, {
    target,
    props: { content, onchange: () => {} },
  }) as unknown as LoadableEditorHandle;
  await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull(), {
    timeout: 30_000,
  });
  return handle;
}

async function mountEditor(content = ''): Promise<EditorView> {
  return (await mountEditorHandle(content)).getProseMirrorView()!;
}

/** One keystroke, through every plugin's `handleTextInput` — see header comment. */
function typeChar(view: EditorView, ch: string): void {
  const from = view.state.selection.from;
  const to = view.state.selection.to;
  for (const plugin of view.state.plugins) {
    const handler = plugin.props.handleTextInput;
    if (handler && handler(view, from, to, ch)) return;
  }
  view.dispatch(view.state.tr.insertText(ch, from, to));
}

function typeDivider(view: EditorView): void {
  for (const ch of '---') typeChar(view, ch);
}

function findEmptyTextblockPos(doc: ProseNode): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos === -1 && node.isTextblock && node.textContent === '') pos = p + 1;
    return pos === -1;
  });
  return pos;
}

function setCaret(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/**
 * Asserts the QA-013/QA-018 end state: an `hr`, immediately followed by
 * exactly one empty paragraph, with the caret collapsed at its start —
 * regardless of what came before the rule or what container it landed in.
 */
function expectDividerEndState(view: EditorView): void {
  const { doc, selection } = view.state;
  expect(selection.empty).toBe(true);
  // Not a NodeSelection on the hr — that is exactly what dragged the
  // viewport in QA-018.
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

  // The caret sits INSIDE that paragraph (right after its opening tag), not
  // on the hr itself and not merged into a later sibling.
  const hrNode = doc.nodeAt(hrPos);
  expect(selection.from).toBe(hrPos + (hrNode?.nodeSize ?? 1) + 1);
}

describe('typing --- across starting states (QA-018, the input-rule path)', () => {
  it('empty document', async () => {
    const view = await mountEditor('');
    typeDivider(view);
    expectDividerEndState(view);
  });

  it('an empty line between two paragraphs of text', async () => {
    const view = await mountEditor('alpha\n\nbeta\n');
    let emptyPos = findEmptyTextblockPos(view.state.doc);
    if (emptyPos === -1) {
      // This build's markdown parser collapsed the blank line; force one by
      // splitting `alpha`'s paragraph at its own boundary.
      view.dispatch(view.state.tr.split(view.state.doc.child(0).nodeSize + 1));
      emptyPos = findEmptyTextblockPos(view.state.doc);
    }
    setCaret(view, emptyPos);
    typeDivider(view);
    expectDividerEndState(view);
    // `beta` must survive, untouched, as its own paragraph after the new one.
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '|')).toContain('beta');
  });

  it('the end of a paragraph with text, after pressing Enter', async () => {
    const view = await mountEditor('hello world\n');
    const endPos = view.state.doc.content.size - 1;
    setCaret(view, endPos);
    view.dispatch(view.state.tr.split(view.state.selection.from));
    typeDivider(view);
    expectDividerEndState(view);
    expect(view.state.doc.textBetween(0, view.state.doc.content.size, '|')).toContain(
      'hello world',
    );
  });

  it('inside a list item, after pressing Enter for a new item', async () => {
    const view = await mountEditor('- one\n- two\n');
    let twoEnd = -1;
    view.state.doc.descendants((node, p) => {
      if (twoEnd === -1 && node.isTextblock && node.textContent === 'two') {
        twoEnd = p + node.nodeSize - 1;
      }
      return twoEnd === -1;
    });
    setCaret(view, twoEnd);
    view.dispatch(view.state.tr.split(view.state.selection.from));
    typeDivider(view);
    expectDividerEndState(view);
  });
});

/*
 * Regression: opening a note with a mid-document divider must never rewrite
 * it. `newlyCreatedDivider` used to fire on ANY transaction that introduced an
 * `hr` — true for the user typing `---`/picking `/divider`, but ALSO true when
 * a note carrying a `***`/`---` is simply LOADED, since a load replaces the
 * document in one transaction too. The fix only lets a load-bearing transaction
 * (checked via documentChanges.ts's `isReportableDocumentChange`, the same
 * predicate the change-notification pipeline already uses to mean "the user
 * did something") through; every content write here — `openNote` and the
 * chunked/progressive path via `censusLoad` — marks its transaction
 * `addToHistory: false` and so must leave the document untouched.
 */
describe('opening a note must never move a divider or its caret (regression)', () => {
  // Two dividers deliberately in different contexts: a bare top-level one, and
  // one nested inside a blockquote — the plugin used to fire on either kind of
  // `hr`, wherever it appeared in whatever chunk introduced it. `***`, not
  // `---`, so `markdownChunks.ts`'s front-matter guard never declines a cut
  // near it (that guard is about `---` specifically).
  const NOTE_WITH_MID_DOCUMENT_DIVIDERS =
    'Intro paragraph.\n\n' +
    '***\n\n' +
    'Body text after the first divider.\n\n' +
    '- one\n' +
    '- two\n\n' +
    '> quoted intro.\n' +
    '>\n' +
    '> ***\n' +
    '>\n' +
    '> quoted tail.\n\n' +
    'tail paragraph.\n';

  it('a plain open (below the chunking threshold) leaves the note byte-identical', async () => {
    const handle = await mountEditorHandle('');
    handle.openNote(NOTE_WITH_MID_DOCUMENT_DIVIDERS);

    expect(handle.getContent()).toBe(NOTE_WITH_MID_DOCUMENT_DIVIDERS);
  });

  it('the chunked/progressive path leaves the same note byte-identical', async () => {
    const handle = await mountEditorHandle('');
    // Tiny budgets force `markdownChunks.ts` to actually cut this short note
    // into several pieces — the production 400-line threshold never would.
    const result = handle.censusLoad(NOTE_WITH_MID_DOCUMENT_DIVIDERS, {
      minLines: 1,
      firstChunkLines: 1,
      chunkLines: 1,
    });

    // A test that never took the chunked path would prove nothing.
    expect(result.chunked).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.markdown).toBe(NOTE_WITH_MID_DOCUMENT_DIVIDERS);
  });
});
