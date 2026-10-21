import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test as base, type Page } from '@playwright/test';

import { HOLD_SETTLE_MS } from '../src/features/editor/milkdown/interactionHold';
import { OPEN_COMPLETE_MEASURE } from '../src/features/editor/milkdown/progressiveLoad';
import { EDITOR_URL } from './editorEmbedBundle';
import { PERFORMANCE_BUDGET } from './editor-gauntlet/performanceFloor';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  openEmbed,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  CHANGE_DEBOUNCE_MS,
  hostConfig,
  hostSetContent,
  initialize,
  largeNote,
  settleChangeDebounce,
} from './lib/editorEmbedSpec';

/**
 * Progressive open and the parse cap: how the bundle both native shells ship
 * opens a large note, and the guarantee that a partially loaded note is never
 * saved. The rest of the bridge contract is
 * `editor-embed-milkdown.spec.ts`.
 */

/**
 * Records whether the progressive-open affordance ever appeared, for the whole
 * life of the page. Installed as an init script rather than armed per test:
 * how long a tail takes to stream is a property of the machine, so polling for
 * it would be asserting that this box is slow, and a test that has to remember
 * to arm its own watch is a test that will one day forget.
 */
function installStreamingTailWatch(): void {
  const w = window as unknown as { __tail: { seen: boolean; role: string | null } };
  w.__tail = { seen: false, role: null };
  new MutationObserver(() => {
    const el = document.querySelector('.milkdown-stream-tail');
    if (!el) return;
    w.__tail.seen = true;
    w.__tail.role = el.getAttribute('role');
    // `document`, not `document.documentElement`: an init script runs before
    // the latter exists, and a MutationObserver takes the Document itself.
  }).observe(document, { childList: true, subtree: true });
}

function readTailWatch(page: Page): Promise<{ seen: boolean; role: string | null }> {
  return page.evaluate(
    () => (window as unknown as { __tail: { seen: boolean; role: string | null } }).__tail,
  );
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    await context.addInitScript(installStreamingTailWatch);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

// ============================================================
// Progressive open — the large-note story (issue #105)
// ============================================================
//
// A large note opens viewport-first: the first chunk is parsed and mounted
// synchronously, the rest streams in idle slices
// (src/features/editor/milkdown/progressiveLoad.ts). The whole design turns on
// one guarantee — a partially loaded note can never be saved — because
// serializing a half-loaded document writes a TRUNCATED file, and the editor
// hands content to the host through exactly two doors: the `change` message and
// `getContent()`. Both are locked here.
//
// The chunked-parse-equals-whole-parse half of the proof is not here: it is a
// property of every note in a 31k-note corpus, which is
// `scripts/milkdown-chunk-census.mjs`, not a spec case.

/**
 * Drives one `initialize` and reports what the editor looked like INSIDE the
 * same task — before any idle slice could run. That is what makes "mid-stream"
 * deterministic instead of a race: progressive open applies chunk 0 in the
 * calling task and schedules everything else.
 */
async function initializeAndPeekMidStream(page: Page, content: string) {
  return page.evaluate((json) => {
    const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
    w.__msgs.length = 0;
    w.FutoEditor.initialize(json);
    return {
      contentDuringStream: w.__futoTest.readDocument(),
      messageTypes: w.__msgs.map((m) => m.type),
      mountedBlocks: document.querySelectorAll('.ProseMirror > *').length,
    };
  }, hostConfig({ content }));
}

/**
 * Resolves once the streaming affordance has come and gone — and FAILS if it
 * never came.
 *
 * Waiting only for `detached` would resolve instantly for a note the chunk
 * planner declined, and every assertion after it would then pass while
 * exercising the ordinary whole-document load: a test going green having
 * checked nothing (AGENTS.md M11). The planner's decline conditions are
 * exactly the kind of thing a later change moves.
 */
async function waitForStreamComplete(page: Page): Promise<void> {
  await page.waitForSelector('.milkdown-stream-tail', { state: 'detached', timeout: 60000 });
  expect(
    (await readTailWatch(page)).seen,
    'this note never took the progressive path — the assertions below prove nothing',
  ).toBe(true);
  await settleChangeDebounce(page);
}

test('a large note mounts only its first chunk before the tail streams', async ({ page }) => {
  const note = largeNote();

  const peek = await initializeAndPeekMidStream(page, note);

  // The whole note is ~15k lines; the first chunk's budget is 80.
  expect(peek.mountedBlocks).toBeGreaterThan(0);
  expect(peek.mountedBlocks).toBeLessThan(200);

  await waitForStreamComplete(page);

  const mountedAfter = await page.evaluate(
    () => document.querySelectorAll('.ProseMirror > *').length,
  );
  // 800 sections, each a heading plus a body paragraph.
  expect(mountedAfter).toBeGreaterThan(1500);
});

test('the save lock holds: no change message while the tail is streaming', async ({ page }) => {
  const peek = await initializeAndPeekMidStream(page, largeNote());

  expect(peek.messageTypes).not.toContain('change');

  await waitForStreamComplete(page);

  // Still none: a clean open never reports a change, streamed or not.
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('the save lock holds: getContent mid-stream returns the original bytes', async ({ page }) => {
  const note = largeNote();

  const peek = await initializeAndPeekMidStream(page, note);

  // Not a prefix of the note — the note itself.
  expect(peek.contentDuringStream).toBe(note);

  await waitForStreamComplete(page);
  expect(await getContent(page)).toBe(note);
});

test('opening and closing a large note leaves it byte-identical', async ({ page }) => {
  // The load-echo guard (ADR-0002) over the chunked path: Milkdown would
  // normalize this markdown on a real edit, and must not on an open.
  const note =
    Array.from({ length: 600 }, (_, i) => `*   item ${i}\n\nSome __bold__ text ${i}.`).join(
      '\n\n',
    ) + '\n';

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('a large note with front matter survives the chunked path and an edit', async ({ page }) => {
  // Progressive open parses each chunk as its own little document, and front
  // matter is a document-START construct — so a chunk that BEGAN with `---`
  // would parse a mid-note thematic break as front matter, which cannot be
  // appended past the document's first position. `markdownChunks.ts` refuses
  // those boundaries; this is the end-to-end proof, with the note also carrying
  // a `---` rule further down for the boundary the planner has to decline.
  const note =
    '---\ntitle: Big\ntags: [a, b]\n---\n\n' +
    Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nBody ${i}.`).join('\n\n') +
    '\n\n---\n\ntail paragraph.\n';

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  // Opening changes nothing (the load-echo guard), front matter included.
  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);

  await clearMessages(page);
  await focusEditor(page);
  await page.keyboard.type('X');
  const changes = await waitForMessages(page, 'change');
  const written = changes[changes.length - 1].content as string;

  // WHERE the character lands is deliberately not asserted: on a note this
  // large the browser's own document-boundary motion depends on scroll and
  // layout timing, so no keyboard shortcut puts the caret at a known offset. What matters is what the edit did to everything
  // ELSE, and that is pinned exactly.
  expect(written.startsWith('---\ntitle: Big\ntags: [a, b]\n---\n\n')).toBe(true);
  // Exactly three `---` lines in the whole note: the front matter's own fences
  // and the mid-document rule, which the house style writes `---` too. A
  // setext underline, or the block re-fenced anywhere, would break this.
  expect(written.match(/^---$/gm)).toHaveLength(3);
  // One character inserted, and nothing else: the note is already in the
  // house style.
  expect(written.replace('X', '')).toBe(note);
});

test('streamed appends are not undoable — Ctrl-Z after an open keeps the note', async ({
  page,
}) => {
  const note = largeNote(600);

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);
  await focusEditor(page);

  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  // Undo neither un-loaded a chunk nor emptied the document.
  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('an edit made while the tail streams is released against the COMPLETE note', async ({
  page,
}) => {
  const note = largeNote(600);

  // Type into the first viewport in the same task the load starts in, so the
  // keystroke provably lands before the tail has finished arriving.
  await page.evaluate(
    (json) => {
      const w = window as unknown as FakeHostWindow;
      w.__msgs.length = 0;
      w.FutoEditor.initialize(json);
      w.FutoEditor.focus();
    },
    hostConfig({ content: note }),
  );
  await page.keyboard.type('EDITED ');
  await waitForStreamComplete(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.length).toBeGreaterThan(0);
  const saved = changes[changes.length - 1].content as string;

  // No trailing space: a save writes no whitespace at a line's end.
  expect(saved).toContain('EDITED');
  // The tail is all there: the last section of the note survived the edit.
  expect(saved).toContain('Section 599');
  expect(await getContent(page)).toBe(saved);
});

test('a focus while the tail streams holds the next chunk until the focus settles', async ({
  page,
}) => {
  // The interaction hold (interactionHold.ts): the frames right after a tap
  // or a focus belong to the caret, the keyboard and the focus work, so the
  // streamed tail waits out a settle window before its next slice instead of
  // landing a chunk parse between the finger and the caret. The proof is the
  // time the first streamed chunk reaches the DOM, taken by a MutationObserver
  // in the task that appended it — not a sampled frame, so no race.
  const sections = 1200;
  const note = largeNote(sections);

  const run = await page.evaluate(
    (json) => {
      const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
      w.__msgs.length = 0;
      let focusAt: number | null = null;
      const onFocus = () => (focusAt ??= performance.now());
      window.addEventListener('focusin', onFocus, true);
      w.FutoEditor.initialize(json);
      const root = document.querySelector('.ProseMirror') as HTMLElement;
      const blocksAtFocus = root.childElementCount;
      w.FutoEditor.focus();
      window.removeEventListener('focusin', onFocus, true);
      return new Promise<{
        focusAt: number | null;
        blocksAtFocus: number;
        firstAppendAfterFocusMs: number;
      }>((resolve) => {
        const observer = new MutationObserver(() => {
          if (root.childElementCount <= blocksAtFocus) return;
          observer.disconnect();
          resolve({
            focusAt,
            blocksAtFocus,
            firstAppendAfterFocusMs: performance.now() - (focusAt ?? Number.NaN),
          });
        });
        observer.observe(root, { childList: true });
      });
    },
    hostConfig({ content: note }),
  );

  // Chunk 0 only: a heading and a body paragraph per section is the whole note.
  expect(run.blocksAtFocus, 'the note must still be streaming when the focus lands').toBeLessThan(
    2 * sections,
  );
  expect(run.focusAt, 'the focus never reached the page').not.toBeNull();
  expect(run.firstAppendAfterFocusMs).toBeGreaterThanOrEqual(HOLD_SETTLE_MS);

  // Held, not dropped: the tail resumes and the open completes exactly once,
  // with the save lock intact — no change message, the host's bytes back.
  await waitForStreamComplete(page);
  expect(
    await page.evaluate((name) => performance.getEntriesByName(name).length, OPEN_COMPLETE_MEASURE),
  ).toBe(1);
  expect(await messagesOfType(page, 'change')).toEqual([]);
  expect(await getContent(page)).toBe(note);
});

test('a flush mid-stream after an edit settles the complete document', async ({ page }) => {
  // The other half of the save lock. With nothing typed, `getContent` can
  // answer with the host's own bytes for free; once the user has edited, the
  // only answer carrying BOTH the edit and the tail costs the rest of the
  // parse, and this asserts it is paid rather than a prefix returned.
  // Big enough that the tail outlives the keystrokes below — the assertion on
  // `streaming` keeps that honest rather than assumed.
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
  await page.keyboard.type('EDITED ');

  // Read while the tail is still arriving.
  const midStream = await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    return {
      streaming: document.querySelectorAll('.milkdown-stream-tail').length,
      content: w.__futoTest.readDocument(),
    };
  });

  expect(midStream.streaming).toBe(1);
  // No trailing space: a save writes no whitespace at a line's end.
  expect(midStream.content).toContain('EDITED');
  // The tail, which had not been parsed when the read started.
  expect(midStream.content).toContain('Section 3999');
});

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

/**
 * The read-only diagnostic global `src/editor-embed/main.ts` installs for the
 * gauntlet. Deliberately NOT part of `FakeHostWindow`, which mirrors the
 * futoBridge contract exactly (apps/ios BridgeCallSurfaceTests scans that
 * surface) — this is not a contract member.
 */
interface ProseMirrorDiagnosticWindow {
  __futoProseMirrorView: () => {
    state: {
      doc: { content: { size: number }; resolve(pos: number): unknown };
      tr: { setSelection(selection: unknown): { scrollIntoView(): unknown } };
      selection: { from: number; constructor: { near(pos: unknown): unknown } };
    };
    dispatch(tr: unknown): void;
    domAtPos(pos: number): { node: Node };
  };
}

/**
 * The scoped list-order pass re-labels the items of a bullet list whose first
 * item says `ordered`. It wrote each item's attrs at the item's offset INSIDE
 * the list instead of its document position (RC-55, copied from upstream), so
 * the attrs landed on whatever block sat at that offset of the document: a
 * heading was reset to H1, and a text node there made `setNodeMarkup` throw
 * and dropped the whole transaction. Reached by dispatching such a list
 * directly — no typed path was found that builds one.
 */
test('list relabelling writes item attrs at document positions, not list-relative ones', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: 'seed\n' }));
  const outcome = await page.evaluate(() => {
    interface Json {
      type: string;
      attrs?: Record<string, unknown>;
      content?: Json[];
      text?: string;
    }
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: { content: { size: number } };
            schema: { nodeFromJSON(json: Json): { content: unknown } };
            tr: { replaceWith(from: number, to: number, content: unknown): unknown };
          };
          dispatch(tr: unknown): void;
        };
      }
    ).__futoProseMirrorView();
    const text = (t: string): Json => ({ type: 'text', text: t });
    const item = (t: string, label: string): Json => ({
      type: 'list_item',
      attrs: { label, listType: 'ordered', spread: true },
      content: [{ type: 'paragraph', content: [text(t)] }],
    });
    const doc = view.state.schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [text('Title')] },
        { type: 'paragraph', content: [text('body')] },
        { type: 'bullet_list', content: [item('x', '7.'), item('y', '9.'), item('z', '9.')] },
      ],
    });
    try {
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(outcome).toBeNull();
  await flushFrames(page);
  const content = await getContent(page);
  expect(content).toMatch(/^### Title\n/);
  expect(content).toContain('1. x');
  expect(content).toContain('3. z');
});

/**
 * Every top-level block is rendered eagerly: the editor applies no
 * `content-visibility` containment to its blocks. One ran on Chromium from
 * #106 until 2026-09-05, when eager rendering measured better on the low-end
 * Android reference phone on every axis — above all the FIRST focus of a large
 * note, which the skipped blocks stalled quadratically (12 s at 1,000 blocks; a
 * real tap froze the app). docs/plan/milkdown-transition.md §5 "Containment
 * retired" has the table. This locks the rule's ABSENCE, and the behavior a
 * large note must keep either way: the caret can move to the far end of the
 * document and land on real, rendered content.
 */
test('every block renders eagerly, and the caret can reach the far end of a large note', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  const styles = await page.evaluate(() => {
    const blocks = document.querySelectorAll('.ProseMirror > *');
    const middle = blocks[Math.floor(blocks.length / 2)] as Element;
    return {
      blocks: blocks.length,
      contentVisibility: getComputedStyle(middle).getPropertyValue('content-visibility'),
    };
  });
  expect(styles.blocks).toBeGreaterThan(400);
  expect(styles.contentVisibility).toBe('visible');

  // Caret into the far end of the document: place the selection there the way
  // in-app navigation does (a scrolled dispatch), then type with the real
  // keyboard. If caret entry or scroll anchoring broke, the keystroke would
  // land elsewhere or nowhere.
  await focusEditor(page);
  const scrolled = await page.evaluate(() => {
    const view = (window as unknown as ProseMirrorDiagnosticWindow).__futoProseMirrorView();
    const scroller = document.querySelector('.ProseMirror') as HTMLElement;
    const before = scroller.scrollTop;
    /* `Selection.near` is a static, reached through the live selection's
     * constructor so this test needs no prosemirror import of its own — the
     * bundle under test owns the only copy of those classes. */
    const selection = view.state.selection.constructor.near(
      view.state.doc.resolve(view.state.doc.content.size),
    );
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    return { before, after: scroller.scrollTop };
  });
  expect(scrolled.after).toBeGreaterThan(scrolled.before);

  await page.keyboard.type(' THE-END');
  await settleChangeDebounce(page);
  expect((await getContent(page)).trimEnd().endsWith('THE-END')).toBe(true);

  /* The block the CARET landed in is genuinely rendered: its box sits inside
   * the scroller's viewport at its real laid-out size.
   *
   * The caret's block, not the document's last child — the preset keeps a
   * trailing placeholder paragraph after the content and ProseMirror scrolls
   * the CARET into view, so the final element legitimately stays below the
   * fold. Asserting on the last child passed here by luck and was outright
   * wrong on Android, where tests/android-editor-perf.mjs runs the same probe;
   * the two are deliberately kept in the same shape. */
  const landing = await page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    const view = (window as unknown as ProseMirrorDiagnosticWindow).__futoProseMirrorView();
    let block = view.domAtPos(view.state.selection.from).node as Node | null;
    if (block?.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block && (block as HTMLElement).parentElement !== editor) {
      block = (block as HTMLElement).parentElement;
    }
    const rect = (block as HTMLElement).getBoundingClientRect();
    const viewport = editor.getBoundingClientRect();
    return { top: rect.top, height: rect.height, viewportBottom: viewport.bottom };
  });
  expect(landing.height).toBeGreaterThan(0);
  expect(landing.top).toBeLessThan(landing.viewportBottom);
});

/**
 * The one unacceptable failure, tested against a REAL FILE.
 *
 * The two tests above prove the editor never hands out a partial document. This
 * one closes the loop the way the product does: a host that autosaves whatever
 * the editor tells it, a note file on disk, and the app dying mid-stream. The
 * file must come back byte-for-byte.
 *
 * It runs its own browser context because the "kill" IS closing that context
 * while the tail is still arriving — there is no exit path, no flush, no
 * `getContent`, exactly as when an OS kills a backgrounded app.
 *
 * Red-proved: deleting either door of the save lock (the `progressive.loading`
 * early return in the change listener, or the one in `getContent`) turns this
 * test red.
 */
base('killing the app mid-stream leaves the note file byte-untouched', async ({ browser }) => {
  const SECTIONS = 4000;
  /* Heading + list + paragraph per section. Named, because the "still partial"
   * assertion below is about the note's own size: the absolute block count it
   * used to carry was tuned to a slower load, and dropping upstream's
   * `syncHeadingIdPlugin` — which re-stamped every heading id after every
   * appended chunk — made the stream fast enough to blow through it while the
   * load was still genuinely partial. */
  const TOP_LEVEL_BLOCKS = SECTIONS * 3;
  const note =
    Array.from(
      { length: SECTIONS },
      (_, i) => `## Section ${i}\n\n*   loose item ${i}\n\nBody __${i}__ text.`,
    ).join('\n\n') + '\n';

  const dir = mkdtempSync(path.join(tmpdir(), 'futo-progressive-'));
  const notePath = path.join(dir, 'note.md');
  writeFileSync(notePath, note, 'utf8');
  const originalBytes = readFileSync(notePath);

  const { context, page } = await openEmbed(browser, EDITOR_URL);
  try {
    // The host's autosave: every `change` the editor reports is written to the
    // note file, immediately, which is what makes a truncated `change` fatal.
    await page.exposeFunction('__futoHostAutosave', (content: string) => {
      writeFileSync(notePath, content, 'utf8');
    });
    await page.evaluate(() => {
      const w = window as unknown as FakeHostWindow & {
        futoBridge: { postMessage(json: string): void };
        __futoHostAutosave(content: string): void;
      };
      w.futoBridge = {
        postMessage: (json: string) => {
          const message = JSON.parse(json) as { type: string; content?: string };
          w.__msgs.push(message as never);
          if (message.type === 'change' && typeof message.content === 'string') {
            void w.__futoHostAutosave(message.content);
          }
        },
      };
    });

    await page.evaluate(
      (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
      hostConfig({ content: note }),
    );

    await page.waitForSelector('.milkdown-stream-tail', { state: 'attached' });

    /* Sit here, mid-stream, for longer than the change listener's own 200 ms
     * debounce. This is what gives the test teeth: without it the context
     * closed within milliseconds of chunk 0, before any `change` could have
     * been delivered — so the file came back untouched whether or not the save
     * lock existed, and the test passed with the lock deleted. Inside this
     * window an unlocked editor DOES report a partial document (Milkdown's
     * listener serializes the doc from the transaction that started the
     * debounce, which mid-stream is a prefix), the fake host writes it, and the
     * byte comparison below fails. */
    await page.waitForTimeout(CHANGE_DEBOUNCE_MS * 3);

    // Still streaming: the plug is being pulled on a genuinely partial load.
    expect(await page.locator('.milkdown-stream-tail').count()).toBe(1);
    expect(
      await page.evaluate(() => document.querySelectorAll('.ProseMirror > *').length),
    ).toBeLessThan(TOP_LEVEL_BLOCKS);
  } finally {
    await context.close();
  }

  expect(readFileSync(notePath).equals(originalBytes)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------
// Progressive open agrees with the whole-document parse (RC-38, RC-39, RC-40)
// ------------------------------------------------------------
//
// The planner is a line scanner standing in for micromark, and the release-
// hardening fuzz (lens B) found it cutting INSIDE a code or HTML block, or
// chunking a note whose definitions resolve document-wide, in a dozen shapes.
// The fix is to DECLINE whatever it cannot prove top-level and block-bounded
// (markdownChunks.ts, "THE RULE"), so these notes now load whole. The oracle
// does not care which path a note takes: the first edit after opening must
// write exactly the bytes a whole-document parse writes, with the keystroke
// applied. Each case fails against the scanner it replaces.

/** 84 lines of one plain paragraph: no blank line, no hard starter, no boundary. */
const CHUNK_INTRO = [
  'Intro paragraph.',
  ...Array.from({ length: 84 }, (_, i) => `plain line ${i}`),
].join('\n');
/** A tail long enough to push the note past the 400-line threshold. */
const CHUNK_TAIL = Array.from({ length: 330 }, (_, i) => `tail line ${i}`).join('\n');
const CHUNK_INTRO_REST = CHUNK_INTRO.split('\n').slice(1).join('\n');

const CHUNK_AGREEMENT_CASES: Array<{ name: string; note: string }> = [
  {
    // A fence indented 1 space and closed at column 0, then a second bare
    // fence: the scanner "closed" on the line micromark OPENS, and cut in
    // front of a `#` line that is inside a code block.
    name: 'a fence indented one space and closed at column 0',
    note: `${CHUNK_INTRO}\n\n \`\`\`\ncode A\n\`\`\`\ntext\n \`\`\`\n# not a heading\n\nmore code\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A U+FEFF at the start of a line that became a chunk start: micromark
    // strips it and the line re-parsed as a heading.
    name: 'a U+FEFF in the middle of the note, at the start of a line',
    note: `${CHUNK_INTRO}\n\n\ufeff# not a heading\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A lone CR ends `para` for micromark, so the fence after it opens a code
    // block the (\n-only) scanner never saw.
    name: 'a lone CR hiding a fence opener',
    note: `${CHUNK_INTRO}\r\`\`\`\n\n# in code\n\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a link reference definition inside a list item',
    note: `Intro [site][a].\n${CHUNK_INTRO_REST}\n\n- [a]: https://example.com/x\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a link reference definition inside a blockquote',
    note: `Intro [site][a].\n${CHUNK_INTRO_REST}\n\n> [a]: https://example.com/x\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a footnote definition inside a list item',
    note: `Intro text[^n].\n${CHUNK_INTRO_REST}\n\n- [^n]: note body\n\n${CHUNK_TAIL}\n`,
  },
  {
    // U+00A0 is not blank to CommonMark (space and tab are), so the NBSP line
    // is a paragraph line and `2. x` continues it. `String#trim` called it blank.
    name: 'a NBSP-only line, which CommonMark does not call blank',
    note: `${CHUNK_INTRO}\n\n\u00a0\n2. not a list item\n\n${CHUNK_TAIL}\n`,
  },
  {
    // micromark strips the BOM, so the whole parse sees front matter; the
    // scanner tested line 0 with the BOM on and cut inside the YAML.
    name: 'a BOM before a long front matter block with blank lines in it',
    note: `\ufeff---\n${Array.from({ length: 90 }, (_, i) => (i % 10 === 9 ? '' : `key${i}: v`)).join('\n')}\n---\n\n${CHUNK_INTRO}\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A fence line directly under an HTML block is HTML to micromark, but
    // opened a fence for the scanner.
    name: 'a fence line directly under an HTML block',
    note: `Intro para.\n\n<div>\n\`\`\`\n\ntext\n\n\`\`\`\`\n# in code\n${Array.from({ length: 85 }, (_, i) => `code line ${i}`).join('\n')}\n\nmore code\n\`\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    // `<!DOCTYPE x` directly under a type-6 line is part of THAT block; the
    // scanner opened a type-4 block that survived the blank line and closed on
    // the `>` of `<pre>`, so a blank-line cut landed inside the real <pre>.
    name: 'an HTML declaration line under an HTML block, hiding a <pre> block',
    note: `Intro para.\n\n<div>\n<!DOCTYPE x\n\n<pre>\n${Array.from({ length: 85 }, (_, i) => `pre line ${i}`).join('\n')}\n\n# not a heading\n* not a list\n</pre>\n\n${CHUNK_TAIL}\n`,
  },
  {
    // HTML opened INSIDE a container (unit-tested in markdownChunks.test.ts;
    // the embed suite had none). An unclosed comment in a list item runs through
    // every blank line up to the end of the ITEM, so a blank-line cut inside it
    // turns the comment's body into live markdown.
    name: 'an HTML comment opened in a list item and never closed there',
    note: `Intro para.\n\n- <!--\n${Array.from({ length: 85 }, (_, i) => `  comment line ${i}`).join('\n')}\n\n  # not a heading\n\n- second item\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a <pre> opened in a blockquote',
    note: `Intro para.\n\n> <pre>\n${Array.from({ length: 85 }, (_, i) => `> pre line ${i}`).join('\n')}\n>\n> # h\n> </pre>\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a <script> opened in an ordered list item',
    note: `Intro para.\n\n1. <script>\n${Array.from({ length: 85 }, (_, i) => `   var x${i};`).join('\n')}\n\n   # h\n   </script>\n\n${CHUNK_TAIL}\n`,
  },
  {
    // A ``` line inside the note's own YAML opened a phantom fence in the
    // scanner, which swallowed the real structure after it.
    name: 'a fence-looking line inside the front matter',
    note: `---\n\`\`\`\n---\n\nIntro [x].\n${CHUNK_INTRO_REST}\n\n[x]: /u\n\n\`\`\`\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a reference definition with an escaped bracket in its label',
    note: `Intro [si\\]te].\n${CHUNK_INTRO_REST}\n\n[si\\]te]: https://example.com/x\nmore text\n\n${CHUNK_TAIL}\n`,
  },
  {
    name: 'a reference definition whose label spans two lines',
    note: `Intro [my site].\n${CHUNK_INTRO_REST}\n\n[my\nsite]: https://example.com/x\nmore text\n\n${CHUNK_TAIL}\n`,
  },
  {
    // The unclosed fence on a list marker line: the chunk alone ran the fence to
    // ITS end, so blank lines that belong to the list item landed in the code.
    name: 'an unclosed fence opened on a list item line',
    note: `Intro paragraph.\n\n- ~~~\n${Array.from({ length: 85 }, (_, i) => `  code ${i}`).join('\n')}\n\n\n\n${CHUNK_TAIL}\n`,
  },
];

/** The whole-document parse's serialization, from the same bundle's `?census` door. */
async function wholeDocumentSerialization(page: Page, note: string): Promise<string> {
  const census = await page.context().newPage();
  await census.goto(`${EDITOR_URL}&census`);
  await census.waitForFunction(
    () =>
      typeof (window as unknown as { __futoSerializeCensus?: unknown }).__futoSerializeCensus ===
        'function' &&
      (window as unknown as { __futoEditorMounted?: boolean }).__futoEditorMounted === true,
  );
  const whole = await census.evaluate(
    (md) =>
      (
        window as unknown as { __futoSerializeCensus: (m: string) => { whole: string } }
      ).__futoSerializeCensus(md).whole,
    note,
  );
  await census.close();
  return whole;
}

/** Selection-only placement in front of the first text occurrence of `marker`. */
async function placeCaretBeforeText(page: Page, marker: string): Promise<void> {
  await page.evaluate((m) => {
    const w = window as unknown as FakeHostWindow & {
      __futoProseMirrorView: () => {
        state: {
          doc: {
            descendants(
              cb: (node: { isText: boolean; text?: string }, pos: number) => boolean | void,
            ): void;
          };
          selection: { constructor: { create(doc: unknown, pos: number): unknown } };
          tr: { setSelection(selection: unknown): unknown };
        };
        dispatch(tr: unknown): void;
      };
    };
    w.FutoEditor.focus();
    const view = w.__futoProseMirrorView();
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.isText && node.text?.includes(m)) at = pos + node.text.indexOf(m);
      return true;
    });
    if (at < 0) throw new Error(`marker ${m} not in the document`);
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, at)));
    w.__msgs.length = 0;
  }, marker);
}

/** Types one real key in front of `marker` and returns the bytes the host is told to save. */
async function typeInFrontOfAndReadChange(page: Page, marker: string): Promise<string> {
  await placeCaretBeforeText(page, marker);
  await page.keyboard.type('Z');
  await page.waitForFunction(
    () => (window as unknown as FakeHostWindow).__msgs.some((m) => m.type === 'change'),
    null,
    { timeout: 10_000 },
  );
  const changes = await messagesOfType(page, 'change');
  return String(changes[changes.length - 1].content);
}

for (const { name, note } of CHUNK_AGREEMENT_CASES) {
  test(`the first edit after opening a note with ${name} writes the whole-parse bytes`, async ({
    page,
  }) => {
    const expected = (await wholeDocumentSerialization(page, note)).replace('Intro', 'ZIntro');
    expect(expected).toContain('ZIntro');

    await initialize(page, hostConfig({ content: note }));
    // The stream, if the planner chose one, must finish before the edit.
    await page.waitForSelector('.milkdown-stream-tail', { state: 'detached', timeout: 30_000 });
    // Load echo: an untouched open hands back the host's bytes.
    expect(await getContent(page)).toBe(note);

    const written = await typeInFrontOfAndReadChange(page, 'Intro');
    expect(written.length, 'sanity: the whole note was written').toBeGreaterThan(1000);
    // The BOM is dropped by the first edit (RC-38, Q18 18A); nothing else may differ.
    expect(written).toBe(expected.replace(/^\ufeff/, ''));
  });
}

// RC-38: micromark strips a leading U+FEFF, so every node position is one code
// unit short of `file.value`, and Milkdown's remarkMarker reads
// `file.value.charAt(offset)` — the character BEFORE each `*`/`_` run — as the
// strong/emphasis marker. The first edit re-spelled every emphasis in the note.
// This is the ordinary whole-document open, not the progressive one. The edit
// writes the house style, whose italic is `*` (docs/spec/editor.md "Markdown
// house style"): every mark kept, and spelled the way any note's would be.
for (const [where, bom, body] of [
  ['in another block', '\ufeff', 'Intro para\n\nsome **bold** and _it_ word\n\nx**y**z\n'],
  ['in the same block', '\ufeff', 'Intro para with **bold** and _it_ and x**y**z\n'],
  ['behind a doubled BOM', '\ufeff\ufeff', 'Intro para with **bold** and _it_ and x**y**z\n'],
] as const) {
  test(`a BOM-leading note keeps its bold and italic markers on the first edit (${where})`, async ({
    page,
  }) => {
    const note = `${bom}${body}`;

    await initialize(page, hostConfig({ content: note }));
    // Load echo: the host's bytes, BOM included, until the user edits.
    expect(await getContent(page)).toBe(note);
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
    expect(
      await page.evaluate(() => ({
        strong: document.querySelectorAll('.ProseMirror strong').length,
        em: document.querySelectorAll('.ProseMirror em').length,
      })),
    ).toEqual({ strong: 2, em: 1 });

    const written = await typeInFrontOfAndReadChange(page, 'Intro');
    expect(written).toBe(body.replace('Intro', 'ZIntro').replace('_it_', '*it*'));
  });
}

test('a BOM-leading note that IS large still opens progressively and keeps its emphasis', async ({
  page,
}) => {
  // The BOM is stripped once, before the planner and the parser (Q18 18A), so a
  // BOM note is not a reason to lose progressive open.
  const body = `Intro **bold** para\n\n${largeNote()}`;
  await initialize(page, hostConfig({ content: `\ufeff${body}` }));
  await waitForStreamComplete(page);

  const written = await typeInFrontOfAndReadChange(page, 'Intro');
  expect(written).toBe(body.replace('Intro', 'ZIntro'));
});

// ============================================================
// The parse cap — a note with one enormous block (the huge-note trap)
// ============================================================
//
// Progressive open streams a note in top-level blocks, so it has nothing to
// offer a note that IS one block. Measured against these exact bundle bytes in
// chromium (2026-09-01): the cost of a whole-document parse is driven not by
// the note's size but by the size of its largest INLINE CONTENT RUN, and it is
// superlinear in it — micromark's text tokenizer merges adjacent data tokens by
// splicing one events array, which is quadratic inside a single run.
//
// | fixture (same 1.26 MB either way)      | initialize |
// |---|---|
// | 1.26 MB in ONE line (one inline node)  | 107 ms     |
// | 20k lines, blank line every 200        | 667 ms     |
// | 20k lines, blank line every line       | 2,264 ms   |
// | 20k lines, NO blank line (one run)     | 7,796 ms   |
//
// A user's 50,000-line note with no blank line anywhere took 28 s here and
// minutes on a phone: the editor showed nothing, and because the iOS shell
// cannot read a document that never mounted, Back refused to leave. The editor's
// half of that fix is parse SPEED. The cost was never the note's size: it was
// micromark's text resolver merging adjacent data events with one `splice` per
// run, which is quadratic in the number of runs — and a paragraph of
// single-newline lines produces one run per line. Patched to compact in one
// pass (patches/micromark@4.0.2.patch): 20,000 lines went 4.8 s -> 1.6 s and
// 50,000 went 18.1 s -> 0.9 s, linear in the note.
//
// There is deliberately NO cap and no read-only mode. An earlier attempt
// mounted a bounded read-only preview with a notice, and it was the wrong
// answer to the right measurement: a 4,280-line note is an ordinary pasted
// transcript, and telling its owner the editor cannot open it is a capitulation
// (docs/plan/milkdown-transition.md §5).

/**
 * A note that is ONE paragraph: every line is a sentence and there is no blank
 * line anywhere, so `planMarkdownChunks` declines it (`no-boundary`) and the
 * whole document goes through a single parse.
 *
 * 20,000 lines rather than the reported 50,000 deliberately: it is the smallest
 * fixture that reproduces the block clearly (7.8 s in chromium against ~50 ms
 * after the cap), and a regression fails the timing assertion below instead of
 * blowing the spec timeout with no message.
 */
function oneParagraphNote(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Line ${i + 1} of this note is an ordinary sentence about something.`,
  ).join('\n');
}

const HUGE_PARAGRAPH_LINES = 20_000;
/** Reference size for the CI-throughput calibration below: same generator,
 * same declined-chunking (`no-boundary`) code path, an order of magnitude
 * smaller so its own cost stays dominated by fixed per-open overhead rather
 * than the parse this test is actually guarding. */
const REFERENCE_LINES = 1_000;
/** A regression to the quadratic resolver blows straight through this. */
const OPEN_BUDGET_MS = 2_000;

async function initializeTimed(page: Page, content: string): Promise<number> {
  return page.evaluate((json) => {
    const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
    w.__msgs.length = 0;
    const started = performance.now();
    w.FutoEditor.initialize(json);
    return performance.now() - started;
  }, hostConfig({ content }));
}

test('a note that is one enormous paragraph opens instead of blocking the engine', async ({
  page,
}) => {
  // CI-2026-09: pipelines 35760-36709 measured THIS test between 2.5 s and
  // 12.7 s elapsed with no code change in between, while a local desktop
  // chromium run does the same 20,000-line open in ~0.5 s. That swing tracks
  // CI runner load, not the product — a fixed CI-only budget would chase a
  // moving target and need re-bumping every time contention shifts (M15).
  // Calibrate instead against a note built by the
  // SAME generator, an order of magnitude smaller, opened moments earlier in
  // this same page/runner: the per-line cost ratio rides out the runner's
  // throughput swings while still failing hard on the actual regression class
  // this test guards against — the quadratic resolver, which does not make
  // per-line cost a little worse, it makes per-line cost balloon with N.
  const referenceElapsed = await initializeTimed(page, oneParagraphNote(REFERENCE_LINES));
  const referencePerLine = referenceElapsed / REFERENCE_LINES;

  const note = oneParagraphNote(HUGE_PARAGRAPH_LINES);
  const elapsed = await initializeTimed(page, note);
  const perLine = elapsed / HUGE_PARAGRAPH_LINES;

  // Healthy (linear) parsing amortizes fixed overhead, so perLine at 20,000
  // lines is normally CHEAPER than at 1,000 (~0.64x locally) — reusing the
  // gauntlet's own cliff factor keeps one definition of "how much worse
  // before it's a cliff, not noise" instead of a second unaudited constant.
  expect(perLine).toBeLessThan(referencePerLine * PERFORMANCE_BUDGET.openCliffFactor);
  // Absolute backstop, not the primary gate: refuse a pathologically slow
  // open even if contention or GC pressure hit only the larger doc and hid
  // it from the ratio above. 15 s clears the worst runner contention seen in
  // the 2026-09 CI history (12.7 s) with margin, well under the job's 90 s
  // Playwright timeout, so this fires as a clear assertion instead of an
  // ambiguous suite timeout.
  expect(elapsed).toBeLessThan(15_000);
  // It really did mount something the user can read, rather than "opening" by
  // rendering nothing at all.
  expect(await page.locator('.ProseMirror').innerText()).toContain('Line 1 of this note');
});

test('a one-paragraph note of ordinary size opens fully editable', async ({ page }) => {
  const note = oneParagraphNote(2_000);

  const elapsed = await initializeTimed(page, note);

  expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
  expect(await getContent(page)).toBe(note);

  await focusEditor(page);
  await page.keyboard.type('x');
  await settleChangeDebounce(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.length).toBeGreaterThan(0);
  expect(await getContent(page)).toContain('x');
});
