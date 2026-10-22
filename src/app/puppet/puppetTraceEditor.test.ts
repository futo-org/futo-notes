// @vitest-environment jsdom
// The trace's view of the real editor. A file of its own because the editor makes documents of
// its own (to parse HTML), and jsdom gives each one window listeners a browser does not have:
// after a mount, every later test in a file would see them among the handlers that ran.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { mountEditor } from './puppetEditor.fixture';
import { handlersOf } from './puppetElements';
import { runPuppetCommand } from './puppetInspector';
import './puppetInspector.fixture';
import { installListenerRegistry } from './puppetListeners';
import { registerPuppetShell } from './puppetRegistry';
import {
  eventsSince,
  installTrace,
  lastEventId,
  resetTrace,
  type ActionRecord,
} from './puppetTrace';
import { isEmptyDiff, type SnapshotDiff } from './puppetSnapshots';

const DOC = 'the quick brown fox\n';

installTrace();
installListenerRegistry();

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the trace over the editor', () => {
  afterEach(() => resetTrace());

  it("shows the editor as one element carrying ProseMirror's listeners as pm", async () => {
    const { view } = await mountEditor(DOC);
    const handlers = handlersOf(view.dom);
    expect(handlers).toContain('mousedown=pm');
    expect(handlers).toContain('keydown=pm');
  });

  it('carries keys, coordinates and the editor position for pointer events over the editor', async () => {
    const { view } = await mountEditor(DOC);
    // jsdom lays nothing out; give ProseMirror a point it can resolve.
    view.posAtCoords = () => ({ pos: 3, inside: -1 });
    const before = lastEventId();
    view.dom.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 12, clientY: 8, shiftKey: true }),
    );
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'b' }));
    await settle();

    const pointer = eventsSince(before).find((e) => e.type === 'mousedown');
    const key = eventsSince(before).find((e) => e.type === 'keydown');
    expect(pointer).toMatchObject({ type: 'mousedown', x: 12, y: 8, modifiers: 'shift' });
    expect(pointer!.handlers.map((h) => h.fn)).toContain('pm');
    expect(pointer!.editor?.resolved).toBe(3);
    expect(pointer!.editor?.settled).toEqual({
      from: expect.any(Number),
      to: expect.any(Number),
    });
    expect(key).toMatchObject({ type: 'keydown', key: 'b' });
    expect(key!.editor).toBeUndefined();
  });

  it('brackets a verb: the receipt carries the action id, the diff and the event count', async () => {
    await mountEditor(DOC);
    registerPuppetShell({ screen: () => 'editor:brown fox', state: () => ({}) });
    runPuppetCommand('do', { verb: 'PlaceCaret', args: { at: 1 } });
    const select = runPuppetCommand('do', { verb: 'Select', args: { from: 11, to: 16 } }).body as {
      action: number;
      diff: SnapshotDiff;
    };
    expect(select.action).toBe(2);
    expect(select.diff.selection).toEqual([
      { from: 1, to: 1 },
      { from: 11, to: 16 },
    ]);
    expect(select.diff.doc).toBeUndefined();

    const bold = runPuppetCommand('do', { verb: 'Bold', args: {} }).body as {
      action: number;
      diff: SnapshotDiff;
    };
    expect(bold.action).toBe(3);
    // Line-addressed, in the saved markdown: the hunk reads as the line it touched.
    expect(bold.diff.doc).toEqual({ line: 1, removed: 'brown', inserted: '**brown**' });

    const last = runPuppetCommand('diff', {}).body as ActionRecord;
    expect(last).toMatchObject({ id: 3, kind: 'do', verb: 'Bold', status: 200 });
    expect((runPuppetCommand('diff', { action: 2 }).body as ActionRecord).verb).toBe('Select');
    expect(runPuppetCommand('diff', { action: 7 }).status).toBe(404);
  });

  it('diffs a snapshot against the page as it is now', async () => {
    const { view } = await mountEditor(DOC);
    registerPuppetShell({ screen: () => 'editor:brown fox', state: () => ({}) });
    const select = runPuppetCommand('do', { verb: 'Select', args: { from: 11, to: 16 } }).body as {
      action: number;
    };
    const before = (runPuppetCommand('diff', { action: select.action }).body as ActionRecord)
      .before;
    runPuppetCommand('do', { verb: 'Bold', args: {} });
    // A change no action recorded is in it too: it is the page now.
    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
    const now = runPuppetCommand('diff', { from: before }).body as SnapshotDiff;
    expect(now.before).toBe(before);
    expect(now.after).toBeGreaterThan(before);
    expect(now.doc).toEqual({ line: 1, removed: 'brown fox', inserted: '**brown** fox!' });
    expect(runPuppetCommand('diff', { from: 99999 }).status).toBe(404);
  });

  it('omits the diff from a receipt when nothing changed', async () => {
    await mountEditor(DOC);
    runPuppetCommand('do', { verb: 'PlaceCaret', args: { at: 1 } });
    const body = runPuppetCommand('do', { verb: 'PlaceCaret', args: { at: 1 } }).body as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('diff');
    expect(isEmptyDiff((runPuppetCommand('diff', {}).body as ActionRecord).diff)).toBe(true);
  });
});
