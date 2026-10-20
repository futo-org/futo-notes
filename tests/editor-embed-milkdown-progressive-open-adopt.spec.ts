// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import {
  clearMessages,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  settleChangeDebounce,
  readTailWatch,
  test,
  hostConfig,
  initialize,
  hostSetContent,
} from './lib/editorEmbedMilkdown';
import { largeNote, waitForStreamComplete } from './lib/editorEmbedMilkdownStream';

/*
 * "Did the user edit while the tail streamed?" must not alias (RC-11: L6a-2,
 * L6b-12, L6b-12b). The answer used to be `undoDepth > depth when the load
 * started`, and undo depth is not a count of edits: a sync adopt keeps the
 * user's history (no `resetHistory` — see "a version adopted from outside the
 * editor"), an Undo LOWERS the depth, and prosemirror-history trims its stack
 * from 120 events back to 100. Either way a real edit netted to "not edited":
 * no `change`, and `getContent()` answered the peer's bytes while the typed
 * word sat on screen, to be lost on the next leave.
 */

const TYPED_MID_STREAM = 'the keystrokes must land while the tail streams (M11)';

/** Top-level blocks mounted right now; a streaming note has only its head. */
async function mountedBlocks(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.ProseMirror > *').length);
}

/** The history plugin's recorded undo events. */
async function undoEvents(page: Page): Promise<number> {
  return page.evaluate(() => {
    type HistoryPlugin = {
      key: string;
      getState: (state: unknown) => { done: { eventCount: number } };
    };
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => { state: { plugins: HistoryPlugin[] } };
      }
    ).__futoProseMirrorView();
    const plugin = view.state.plugins.find((p) => String(p.key).startsWith('history$'));
    return plugin!.getState(view.state).done.eventCount;
  });
}

/** A selection-only caret move to the start of the text holding `marker`. */
async function caretBefore(page: Page, marker: string): Promise<void> {
  await page.evaluate((text) => {
    type ProseNodeLike = { isText: boolean; text?: string };
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: { descendants: (f: (n: ProseNodeLike, pos: number) => boolean) => void };
            selection: { constructor: { create: (doc: unknown, pos: number) => unknown } };
            tr: { setSelection: (s: unknown) => unknown };
          };
          dispatch: (tr: unknown) => void;
        };
      }
    ).__futoProseMirrorView();
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text);
      return true;
    });
    if (at < 0) throw new Error(`no text ${text}`);
    const selection = view.state.selection.constructor.create(view.state.doc, at);
    view.dispatch(view.state.tr.setSelection(selection));
  }, marker);
}

/** Adopt `note` as a sync update would, and report whether it took the streaming path. */
async function adoptStreaming(page: Page, note: string): Promise<boolean> {
  return page.evaluate((md) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.applyExternalContent(
      'test-note',
      md,
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    );
    w.__msgs.length = 0;
    // The tail affordance is Svelte state, painted after this task; the block
    // count is synchronous. Only chunk 0 is mounted yet.
    return document.querySelectorAll('.ProseMirror > *').length < 1000;
  }, note);
}

test('an Undo while an adopted note streams does not hide the word typed after it', async ({
  page,
}) => {
  await hostSetContent(page, 'small note\n');
  await focusEditor(page);
  await page.keyboard.type('edited ');
  await waitForMessages(page, 'change');

  const peer = largeNote(3000);
  expect(await adoptStreaming(page, peer), 'the adopt must take the progressive path').toBe(true);

  // The pre-adopt step maps to nothing over the replaced document: this Undo
  // changes no text, only the undo depth.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.type('QQQ');
  expect(await mountedBlocks(page), TYPED_MID_STREAM).toBeLessThan(5000);
  await expect(page.locator('.ProseMirror')).toContainText('QQQ');

  await waitForStreamComplete(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.some((m) => String(m.content).includes('QQQ'))).toBe(true);
  const content = await getContent(page);
  expect(content).toContain('QQQ');
  expect(content).toContain('Section 2999');
});

test('a word typed while an adopted note streams is reported with the undo stack full', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await initialize(page, hostConfig({ content: largeNote(300) }));
  await waitForStreamComplete(page);
  await focusEditor(page);
  // 120 separate undo events, at two non-adjacent places so none merge: the
  // stack is at the depth where the next event trims it back to 100.
  for (let i = 0; i < 120; i += 1) {
    await caretBefore(page, i % 2 === 0 ? 'Body line 1 ' : 'Body line 7 ');
    await page.keyboard.type('x');
  }
  expect(await undoEvents(page), 'the undo stack must be at its trim threshold').toBe(120);
  await settleChangeDebounce(page);

  const peer = largeNote(3000).replace('Body line 0 ', 'Peer line 0 ');
  expect(await adoptStreaming(page, peer), 'the adopt must take the progressive path').toBe(true);
  await caretBefore(page, 'Peer line 0 ');
  await page.keyboard.type('Q');
  expect(await mountedBlocks(page), TYPED_MID_STREAM).toBeLessThan(5000);
  expect(await undoEvents(page), 'this keystroke must have trimmed the stack').toBeLessThan(120);

  await waitForStreamComplete(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.some((m) => String(m.content).includes('QPeer line 0 '))).toBe(true);
  expect(await getContent(page)).toContain('QPeer line 0 ');
});

/*
 * applyExternalContent over an unreported edit (RC-08, FB-5).
 *
 * Both native shells classify a peer's edit or delete of the OPEN note
 * (`classify_open_note`) from a draft kept current by `change` messages. Two
 * windows leave that draft behind the editor: a large note withholds `change`
 * while its tail streams (the save lock), and every edit spends 200 ms in the
 * change debounce. Classified on that draft, the edit read as "nothing to
 * lose": a peer edit was adopted over it (`applyExternalContent` discards the
 * document) and a peer delete closed the note. So the shells now READ the
 * editor before classifying, without blurring it (a reconcile may not take the
 * keyboard from a typist). These pin what that read has to give them: the
 * edit, over the whole note, with the `change` that brings the shell's own copy
 * level posted inside the read — and focus left where it was.
 */
async function reconcileRead(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    const before = w.__msgs.length;
    const streaming = document.querySelectorAll('.milkdown-stream-tail').length > 0;
    w.FutoEditor.flush('reconcile');
    const content = String(w.__msgs.filter((m) => m.type === 'change').at(-1)?.content);
    const posted = w.__msgs.slice(before);
    return {
      streaming,
      content,
      changes: posted.filter((m) => m.type === 'change').map((m) => String(m.content)),
      blurred: posted.some((m) => m.type === 'focus' && m.focused === false),
      focused: !!document.activeElement?.closest('.ProseMirror'),
    };
  });
}

test('external adoption after a flush uses the reported streaming edit generation', async ({
  page,
}) => {
  const note = largeNote(4000);
  await page.evaluate(
    (json) => {
      const w = window as unknown as FakeHostWindow;
      w.__msgs.length = 0;
      w.FutoEditor.initialize(json);
      w.FutoEditor.focus();
    },
    hostConfig({ content: note }),
  );
  await page.keyboard.type('UNREPORTED ');

  const read = await reconcileRead(page);

  expect(read.streaming, 'the read must land while the tail streams (M11)').toBe(true);
  // No trailing space: a save writes no whitespace at a line's end.
  expect(read.content).toContain('UNREPORTED');
  // Not a prefix (F3): the tail that had not been parsed when the read began.
  expect(read.content).toContain('Section 3999');
  // The shell's change-fed copy is level with the read before the read returns.
  expect(read.changes.at(-1)).toBe(read.content);
  expect(read.blurred).toBe(false);
  expect(read.focused).toBe(true);
});

test('applyExternalContent over an unreported edit: the flush the host requests reports an edit still inside the change debounce', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: 'the note\n' }));
  await focusEditor(page);
  await clearMessages(page);
  await page.keyboard.type('burst');

  // No settle: the burst is still inside the 200 ms debounce.
  const read = await reconcileRead(page);

  expect(read.content).toContain('burst');
  expect(read.changes).toEqual([read.content]);
  expect(read.blurred).toBe(false);
  expect(read.focused).toBe(true);

  // Reported once: the read retired the debounce, so nothing about this
  // document arrives after the host has classified on it.
  await settleChangeDebounce(page);
  expect((await messagesOfType(page, 'change')).length).toBe(1);
});

/** The top-level block shapes of the live document, `p:empty` for an empty paragraph. */
async function topLevelShapes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelector('.ProseMirror')?.children ?? []).map((el) => {
      const tag = el.tagName.toLowerCase();
      return tag === 'p' && el.textContent === '' ? 'p:empty' : tag;
    }),
  );
}

test('progressive open keeps the blank lines the author typed across a chunk seam', async ({
  page,
}) => {
  // An empty paragraph saves as an extra blank line (packages/editor/src/
  // milkdown-compat/emptyLine.ts). The planner cuts after blank runs and leaves
  // the run at the END of a chunk, where a standalone parse cannot see it, so
  // the loader has to re-insert those paragraphs itself. Two extra blank lines
  // deep inside a large note: exactly two empty paragraphs, at that spot.
  const halves = largeNote(400).split('## Section 200\n');
  const note = `${halves[0]}\n\n## Section 200\n${halves[1]}`;

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  const shapes = await topLevelShapes(page);
  const empties = shapes.map((shape, i) => (shape === 'p:empty' ? i : -1)).filter((i) => i >= 0);
  expect(empties).toHaveLength(2);
  // Directly before the heading they precede.
  expect(shapes[empties[1] + 1]).toBe('h2');
  // textContent, not innerText: this asserts what the document holds, not
  // what happens to be laid out.
  expect(
    await page.evaluate(() => document.querySelectorAll('.ProseMirror h2')[200]?.textContent),
  ).toBe('Section 200');
});

test('progressive open does not grow a front-matter note by a blank line', async ({ page }) => {
  // Chunk 0 of such a note is the front matter alone, and the schema pads it
  // with an empty paragraph to satisfy `block+`. That paragraph is the schema's,
  // not the chunk's, and the whole-document parse never has it — four corpus
  // notes opened one blank line longer chunked than whole before this was told
  // apart from a chunk that really does end in an empty paragraph.
  const note = `---\ntitle: x\n---\n\n${largeNote()}`;

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  const shapes = await topLevelShapes(page);
  expect(shapes[1]).toBe('h2');
  expect(shapes).not.toContain('p:empty');
});

test('the streaming tail carries a loading affordance that clears on completion', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  // `waitForStreamComplete` already asserts it appeared; this pins its role.
  expect(await readTailWatch(page)).toEqual({ seen: true, role: 'status' });
  await expect(page.locator('.milkdown-stream-tail')).toHaveCount(0);
});

test('open records time-to-interactive-first-viewport, and it beats time-to-complete', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  const timings = await page.evaluate(() => ({
    interactive: performance.getEntriesByName('futo:editor-open-interactive')[0]?.duration ?? null,
    complete: performance.getEntriesByName('futo:editor-open-complete')[0]?.duration ?? null,
  }));

  expect(timings.interactive).not.toBeNull();
  expect(timings.complete).not.toBeNull();
  /* The assertion is the RATIO, not a wall-clock number. The product budget is
   * "first viewport interactive in under a second" on the low-end reference
   * PHONE (docs/plan/milkdown-transition.md §5 / D7), which is issue #106's to
   * enforce on the device; an absolute millisecond bound here would only be
   * measuring this box, and its next edit would be a bump (AGENTS.md M15).
   * Half is a bound sized to fail a first chunk that parsed the whole
   * document, whatever the machine: this note streams in 8 chunks. */
  expect(timings.interactive!).toBeLessThan(timings.complete! / 2);
});
