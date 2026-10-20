// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test as base } from '@playwright/test';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  flushFrames,
  focusEditor,
  getContent,
  openEmbed,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  CHANGE_DEBOUNCE_MS,
  settleChangeDebounce,
  test,
  hostConfig,
  initialize,
} from './lib/editorEmbedMilkdown';
import { largeNote, waitForStreamComplete } from './lib/editorEmbedMilkdownStream';

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
