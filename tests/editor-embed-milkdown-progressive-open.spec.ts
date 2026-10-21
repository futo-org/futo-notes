// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import { HOLD_SETTLE_MS } from '../src/features/editor/milkdown/interactionHold';
import { OPEN_COMPLETE_MEASURE } from '../src/features/editor/milkdown/progressiveLoad';
import {
  clearMessages,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, test, hostConfig, initialize } from './lib/editorEmbedMilkdown';
import { largeNote, waitForStreamComplete } from './lib/editorEmbedMilkdownStream';

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
