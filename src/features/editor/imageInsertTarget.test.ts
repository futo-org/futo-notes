import { describe, expect, it, vi } from 'vitest';

import { createImageInsertTarget } from './imageInsertTarget';

/** A target over a note id the test can change between `begin` and completion. */
function targetOn(note: { id: string }, overrides: Record<string, unknown> = {}) {
  const insert = vi.fn();
  const discard = vi.fn(async (_filename: string) => {});
  const reportError = vi.fn();
  const target = createImageInsertTarget({
    documentToken: () => note.id,
    insert,
    discard,
    reportError,
    ...overrides,
  });
  return { target, insert, discard, reportError };
}

describe('createImageInsertTarget', () => {
  it('inserts into the note the completion was started on', () => {
    const note = { id: 'note-a' };
    const { target, insert, discard } = targetOn(note);

    target.begin()('image-1.png');

    expect(insert).toHaveBeenCalledWith('image-1.png');
    expect(discard).not.toHaveBeenCalled();
  });

  it('never inserts once the editor has moved to another note', () => {
    const note = { id: 'note-a' };
    const { target, insert } = targetOn(note);
    const complete = target.begin();

    note.id = 'note-b';
    complete('image-1.png');

    expect(insert).not.toHaveBeenCalled();
  });

  it('removes the file an abandoned completion created, and only that file', async () => {
    const note = { id: 'note-a' };
    const { target, discard } = targetOn(note);
    const complete = target.begin();

    note.id = 'note-b';
    complete('image-1.png');
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));

    expect(discard).toHaveBeenCalledWith('image-1.png');
  });

  it('inserts again for a completion started AFTER the note changed', () => {
    const note = { id: 'note-a' };
    const { target, insert } = targetOn(note);

    note.id = 'note-b';
    target.begin()('image-1.png');

    expect(insert).toHaveBeenCalledWith('image-1.png');
  });

  it('keeps a claim valid across a completion that already landed', () => {
    const note = { id: 'note-a' };
    const { target, insert } = targetOn(note);
    const complete = target.begin();

    complete('image-1.png');
    complete('image-2.png');

    expect(insert.mock.calls.map((call) => call[0])).toEqual(['image-1.png', 'image-2.png']);
  });

  it('reports a failed removal rather than rejecting into nothing', async () => {
    const note = { id: 'note-a' };
    const { target, reportError } = targetOn(note, {
      discard: vi.fn(() => Promise.reject(new Error('file is gone'))),
    });
    const complete = target.begin();

    note.id = 'note-b';
    complete('image-1.png');

    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        'Abandoned image could not be removed:',
        expect.any(Error),
      ),
    );
  });

  it('drops the insertion without throwing where the host cannot delete', () => {
    const note = { id: 'note-a' };
    const insert = vi.fn();
    const target = createImageInsertTarget({ documentToken: () => note.id, insert });
    const complete = target.begin();

    note.id = 'note-b';
    expect(() => complete('image-1.png')).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
