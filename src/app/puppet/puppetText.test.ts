// @vitest-environment jsdom
//
// Places in the note: acted on where a person's hand starts, on screen, and refused with steps
// that work from this screen when they are not.
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { errorOf, run } from './puppetInspector.fixture';
import { runPuppetCommand } from './puppetInspector';
import { noteLines } from './puppetNoteLines';
import { registerPuppetShell } from './puppetRegistry';

describe('text off screen', () => {
  const reach = (find: string) => (run('Select', { find }).body as { reach?: unknown }).reach;

  it('is reached by ScrollToLine to its line, on desktop too, where Find could land elsewhere', async () => {
    const { view } = await mountEditor('top line\n\nApple pie\n\nfar apple\n\nSee [[x]] now\n');
    layOutLines(view, { rows: 1 });
    registerPuppetShell({ screen: () => 'editor:x', state: () => ({}) });
    expect(reach('far')).toEqual([['ScrollToLine', { line: 3 }]]);
    // Find would stop at "Apple" first (it folds case) and reads no chip: why it is not the way.
    expect(reach('apple')).toEqual([['ScrollToLine', { line: 3 }]]);
    expect(reach('[[x]]')).toEqual([['ScrollToLine', { line: 4 }]]);
  });

  it('is scrolled to by its line, front matter counting as the one line it is', async () => {
    const { view } = await mountEditor('---\na: 1\nb: 2\n---\n\ntop\n\nApple pie\n\nfar apple\n');
    layOutLines(view, { rows: 1 });
    expect(reach('apple')).toEqual([['ScrollToLine', { line: 4 }]]);
  });
});

describe('a range', () => {
  it('needs only its start on screen, as a drag autoscrolls to its far end', async () => {
    const { view } = await mountEditor('alpha one\n\nbeta two\n\ngamma three\n');
    const [, beta, gamma] = noteLines(view.state.doc).slice(1, 3);
    layOutLines(view, { rows: 2 });
    const selected = run('Select', { from: beta.at, to: gamma.end });
    expect(selected.status).toBe(200);
    expect(JSON.stringify(selected.body)).not.toContain('gamma');
    layOutLines(view, { rows: 2 });
    expect(run('Select', { from: gamma.at, to: gamma.end })).toMatchObject({
      status: 409,
      body: { reach: [['ScrollToLine', { line: 3 }]] },
    });
    layOutLines(view, { rows: 2 });
    expect(run('Select', { find: 'two\ngamma' }).status).toBe(200);
    layOutLines(view, { rows: 2 });
    expect(run('MoveBlock', { line: 1, after: 3 }).status).toBe(200);
  });

  it('with a stale docVersion is refused as stale, whatever shows', async () => {
    const { view } = await mountEditor('alpha\n\nbeta\n');
    layOutLines(view, { rows: 1 });
    const refused = run('PlaceCaret', { at: noteLines(view.state.doc).line(2)!.at, docVersion: 1 });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toContain('document changed');
    expect(refused.body).not.toHaveProperty('reach');
  });
});

it('doc refuses a key it does not take', async () => {
  await mountEditor();
  expect(runPuppetCommand('doc', { from: 0, to: 5 }).status).toBe(400);
});
