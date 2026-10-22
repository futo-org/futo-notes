// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { mountEditor } from './puppetEditor.fixture';
import { runPuppetCommand } from './puppetInspector';
import { puppetVerb, registerPuppetShell, registerPuppetVerbs } from './puppetRegistry';

/** Lets the verb's receipt chain (puppetVerb → recordDo) run to completion. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('registered verbs', () => {
  it('puppetVerb derives the schema, receipts a void run, and relays a refusal', () => {
    const calls: unknown[] = [];
    registerPuppetVerbs(() => [
      puppetVerb('MoveNote', { noteId: 'string', folderPath: 'string?' }, (args) => {
        calls.push(args);
        if (args.noteId === 'missing') return { status: 400, body: { ok: false, error: 'no' } };
      }),
    ]);
    const listed = (runPuppetCommand('actions', {}).body as { actions: Array<{ schema: unknown }> })
      .actions[0];
    expect(listed.schema).toEqual({
      type: 'object',
      properties: { noteId: { type: 'string' }, folderPath: { type: 'string' } },
      required: ['noteId'],
    });
    const done = runPuppetCommand('do', { verb: 'MoveNote', args: { noteId: 'a' } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, verb: 'MoveNote', action: expect.any(Number) });
    expect(runPuppetCommand('do', { verb: 'MoveNote', args: { noteId: 'missing' } }).status).toBe(
      400,
    );
    expect(calls).toEqual([{ noteId: 'a' }, { noteId: 'missing' }]);
  });

  it('a parameter with allowed values lists them and refuses any other before the verb runs', () => {
    const modes: unknown[] = [];
    registerPuppetVerbs(() => [
      puppetVerb('OpenNote', { noteId: 'string', mode: 'current|foreground?' }, (args) => {
        modes.push(args.mode);
      }),
    ]);
    const listed = (runPuppetCommand('actions', {}).body as { actions: Array<{ schema: unknown }> })
      .actions[0];
    expect(listed.schema).toMatchObject({
      properties: { mode: { type: 'string', enum: ['current', 'foreground'] } },
      required: ['noteId'],
    });
    const refused = runPuppetCommand('do', {
      verb: 'OpenNote',
      args: { noteId: 'a', mode: 'new' },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain(
      'must be one of current, foreground, not "new"',
    );
    runPuppetCommand('do', { verb: 'OpenNote', args: { noteId: 'a', mode: 'foreground' } });
    expect(modes).toEqual(['foreground']);
  });

  it('an async verb answers 202 now and its action record settles with the result and diff', async () => {
    const { view } = await mountEditor();
    let finish!: () => void;
    registerPuppetVerbs(() => [
      puppetVerb(
        'DeleteNote',
        { noteId: 'string' },
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              view.dispatch(view.state.tr.insertText('a', 1, 4));
              resolve();
            };
          }),
      ),
    ]);
    const receipt = runPuppetCommand('do', { verb: 'DeleteNote', args: { noteId: 'x' } });
    expect(receipt.status).toBe(202);
    const { action } = receipt.body as { action: number };
    expect(runPuppetCommand('diff', { action }).body).toMatchObject({
      pending: true,
      verb: 'DeleteNote',
    });
    finish();
    await settled();
    const record = runPuppetCommand('diff', { action }).body as Record<string, unknown>;
    expect(record.pending).toBeUndefined();
    expect(record).toMatchObject({ status: 200, result: { ok: true, verb: 'DeleteNote' } });
    expect(record.diff).toMatchObject({ doc: { line: 1, removed: 'the', inserted: 'a' } });
  });

  it('a rejected async verb settles as a 500 carrying the error text', async () => {
    registerPuppetVerbs(() => [
      puppetVerb('SyncNow', {}, () => Promise.reject(new Error('offline'))),
    ]);
    const { action } = runPuppetCommand('do', { verb: 'SyncNow', args: {} }).body as {
      action: number;
    };
    await settled();
    expect(runPuppetCommand('diff', { action }).body).toMatchObject({
      status: 500,
      result: { ok: false, error: 'offline' },
    });
  });

  it('a verb that starts a note switch settles only once the shell has switched', async () => {
    // merge-lists turn 6: OpenNote answered 200 while a dirty note was still being saved,
    // and the next observation read the old note's document.
    let openNoteId = 'recipes/pancakes';
    let finishSwitch!: () => void;
    let switching: Promise<void> | undefined;
    registerPuppetShell({
      screen: () => `editor:${openNoteId}`,
      state: () => ({ note: { id: openNoteId } }),
      settled: () => switching,
    });
    registerPuppetVerbs(() => [
      puppetVerb('OpenNote', { noteId: 'string' }, (args) => {
        switching = new Promise<void>((resolve) => {
          finishSwitch = () => {
            openNoteId = args.noteId as string;
            switching = undefined;
            resolve();
          };
        });
      }),
    ]);
    const receipt = runPuppetCommand('do', { verb: 'OpenNote', args: { noteId: 'grocery list' } });
    expect(receipt.status).toBe(202);
    const { action } = receipt.body as { action: number };
    await settled();
    expect(runPuppetCommand('diff', { action }).body).toMatchObject({ pending: true });
    finishSwitch();
    await settled();
    const record = runPuppetCommand('diff', { action }).body as Record<string, unknown>;
    expect(record).toMatchObject({ status: 200, result: { ok: true, verb: 'OpenNote' } });
    expect(record.diff).toMatchObject({
      screen: ['editor:recipes/pancakes', 'editor:grocery list'],
    });
    // With nothing in flight a verb stays synchronous.
    registerPuppetVerbs(() => [puppetVerb('ToggleSidebar', {}, () => {})]);
    expect(runPuppetCommand('do', { verb: 'ToggleSidebar', args: {} }).status).toBe(200);
  });

  it('a switch the shell could not make refuses with its reason, not a 200 that stayed put', async () => {
    // A dirty note whose save fails keeps its tab: OpenNote answered 200 and only the diff
    // showed that nothing had switched.
    registerPuppetShell({
      screen: () => 'editor:recipes/pancakes',
      state: () => ({}),
      settled: () => Promise.resolve('saving recipes/pancakes failed: disk full'),
    });
    registerPuppetVerbs(() => [puppetVerb('OpenNote', { noteId: 'string' }, () => {})]);
    const { action } = runPuppetCommand('do', { verb: 'OpenNote', args: { noteId: 'x' } }).body as {
      action: number;
    };
    await settled();
    expect(runPuppetCommand('diff', { action }).body).toMatchObject({
      status: 409,
      result: { ok: false, error: 'saving recipes/pancakes failed: disk full' },
    });
  });

  it('unregistering removes the verbs from the manifest', () => {
    const unregister = registerPuppetVerbs(() => [puppetVerb('Gone', {}, () => {})]);
    expect(runPuppetCommand('do', { verb: 'Gone', args: {} }).status).toBe(200);
    unregister();
    expect(runPuppetCommand('do', { verb: 'Gone', args: {} }).status).toBe(404);
  });
});
