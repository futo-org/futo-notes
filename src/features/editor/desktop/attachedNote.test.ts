import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Applied, HostAck, HostRequest } from '@futo-notes/editor/wasm-payloads';
import type { EditorOutcome, EditorSaved } from '$lib/platform/tauri/editorHost';

/** The page's engine: what the host's outcomes are compared against. */
const engine = { revision: 0, text: 'base', draftText: () => engine.text };
let emitSaved: (saved: EditorSaved) => void = () => {};
let token = 0;
/** Events the host emits before its switch's reply reaches the page. */
let beforeReply: (token: number) => void = () => {};
const host = {
  editorSwitch: vi.fn(async (noteId: string) => {
    token += 1;
    beforeReply(token);
    return {
      opened: { token, noteId, snapshot: { source: 'base', revision: 0 } },
      closed: null,
    };
  }),
  editorCheckpoint: vi.fn(),
  editorRename: vi.fn(),
  editorReload: vi.fn(),
  editorRequest: vi.fn(),
  editorClose: vi.fn(),
  editorNoteIds: vi.fn(async () => []),
  onEditorSaved: vi.fn(async (handler: (saved: EditorSaved) => void) => {
    emitSaved = handler;
    return () => {};
  }),
};

vi.mock('$lib/platform', () => ({ noteEditorHost: async () => host }));
vi.mock('./engine', () => ({
  Engine: {
    restore: async () =>
      Object.assign(engine, { updateNoteIds: vi.fn(), free: vi.fn(), acknowledge: () => [] }),
  },
}));

import { AttachedNote, type AttachedNoteEvents, type Landed } from './attachedNote';

function outcome(fields: Partial<EditorOutcome> & Pick<EditorOutcome, 'stamp'>): EditorOutcome {
  return {
    noteId: 'Note',
    revision: engine.revision,
    saved: true,
    parked: false,
    mutation: null,
    offered: null,
    recreated: false,
    error: null,
    ...fields,
  };
}

const mutation = (id: string) =>
  ({ notes: [], removed: [id] }) as unknown as EditorOutcome['mutation'];

async function attach(offered: AttachedNoteEvents['offered'] = () => 'refused') {
  const landed: Landed[] = [];
  const order: string[] = [];
  const events = {
    landed: (event: Landed) => {
      landed.push(event);
      if (event.saved) order.push('saved');
    },
    offered: vi.fn(offered),
    saveFailed: () => order.push('failed'),
    deleted: vi.fn(),
  };
  const note = await AttachedNote.open(null, 'Note', false, events);
  return { note, landed, order, events };
}

beforeEach(() => {
  engine.revision = 0;
  engine.text = 'base';
  beforeReply = () => {};
});

describe('the note the attachment holds', () => {
  it('follows a move the host reports on its saves channel', async () => {
    const { note, landed } = await attach();

    emitSaved({
      token: note.token,
      outcome: outcome({ stamp: 1, noteId: 'Moved', saved: false }),
    });

    expect(note.noteId).toBe('Moved');
    expect(landed).toEqual([
      {
        mutation: null,
        fromId: 'Note',
        toId: 'Moved',
        keepsOriginal: false,
        saved: false,
        recreated: false,
      },
    ]);
  });

  /* The worker parked the draft (stamp 1), then renamed the copy (stamp 2), and the
   * rename's reply beat the park's event: applied in arrival order, the park's mutation
   * re-added a row the rename had removed, and the park was lost. */
  it('applies every outcome once, in stamp order, however it arrives', async () => {
    const { note, landed } = await attach();
    host.editorRename.mockResolvedValueOnce(
      outcome({ stamp: 2, noteId: 'Renamed', mutation: mutation('Note (conflict)') }),
    );
    let renamed = false;
    const renaming = note.rename('Renamed').then(() => (renamed = true));
    await vi.waitFor(() => expect(host.editorRename).toHaveBeenCalled());
    await Promise.resolve();
    expect(landed).toEqual([]);
    expect(renamed).toBe(false);

    const parked = outcome({
      stamp: 1,
      noteId: 'Note (conflict)',
      parked: true,
      mutation: mutation('Note'),
    });
    emitSaved({ token: note.token, outcome: parked });
    await renaming;

    expect(landed.map(({ fromId, toId, keepsOriginal }) => [fromId, toId, keepsOriginal])).toEqual([
      ['Note', 'Note (conflict)', true],
      ['Note (conflict)', 'Renamed', false],
    ]);
    expect(landed.map(({ mutation }) => mutation)).toEqual([
      mutation('Note'),
      mutation('Note (conflict)'),
    ]);
    expect(note.noteId).toBe('Renamed');
  });

  it('applies an event that beat the reply opening its note', async () => {
    beforeReply = (opened) =>
      emitSaved({
        token: opened,
        outcome: outcome({ stamp: 1, noteId: 'Moved', saved: false }),
      });
    const { note, landed } = await attach();
    expect(note.noteId).toBe('Moved');
    expect(landed).toHaveLength(1);
  });

  it('still applies the outcomes that were in flight when it was released', async () => {
    const { note, landed } = await attach();
    host.editorClose.mockResolvedValueOnce(outcome({ stamp: 2, saved: true }));
    const closing = note.close(false);
    await vi.waitFor(() => expect(host.editorClose).toHaveBeenCalled());
    emitSaved({
      token: note.token,
      outcome: outcome({ stamp: 1, noteId: 'Moved', saved: false }),
    });
    await closing;
    expect(landed.map(({ toId }) => toId)).toEqual(['Moved', 'Note']);
    // Released for good: nothing later reaches it.
    emitSaved({ token: note.token, outcome: outcome({ stamp: 3 }) });
    expect(landed).toHaveLength(2);
  });

  it('ignores another attachment’s outcomes', async () => {
    const { note } = await attach();
    emitSaved({
      token: note.token + 100,
      outcome: outcome({ stamp: 1, noteId: 'Elsewhere' }),
    });
    expect(note.noteId).toBe('Note');
  });
});

describe('the source the note was saved as', () => {
  it('starts as the opened source and follows a save of the current draft, converged too', async () => {
    const { note } = await attach();
    expect(note.savedSource).toBe('base');

    engine.revision = 3;
    engine.text = 'typed';
    expect(note.idle).toBe(false);
    host.editorCheckpoint.mockResolvedValueOnce(outcome({ stamp: 1, revision: 3 }));
    await note.checkpoint();

    expect(note.savedSource).toBe('typed');
    expect(note.idle).toBe(true);
  });

  it('keeps its baseline when an edit landed after the revision the save wrote', async () => {
    const { note } = await attach();
    engine.revision = 4;
    engine.text = 'typed more';

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, revision: 3 }) });
    expect(note.savedSource).toBe('base');
    expect(note.idle).toBe(false);

    // A save the test hold declined writes nothing either.
    host.editorCheckpoint.mockResolvedValueOnce(outcome({ stamp: 2, saved: false }));
    await note.checkpoint();
    expect(note.savedSource).toBe('base');
  });
});

/* A save that found the note changed outside offers what the note now holds. */
describe('an outside change a save offered', () => {
  const adoption = { change: {}, request: { sequence: 1 } } as unknown as Applied;
  const acknowledged = { paused: false, error: null } as unknown as HostAck;

  function adopting(): Applied {
    engine.revision = 2;
    engine.text = 'merged';
    return adoption;
  }

  it('adopts an offer at the revision it was saved at, and records it as saved', async () => {
    const { note, events } = await attach(adopting);
    engine.revision = 1;
    engine.text = 'typed';
    host.editorRequest.mockResolvedValueOnce(acknowledged);

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, offered: 'merged' }) });

    expect(events.offered).toHaveBeenCalledOnce();
    expect(host.editorRequest).toHaveBeenCalledWith(note.token, adoption.request);
    expect(note.savedSource).toBe('merged');
    await vi.waitFor(() => expect(note.idle).toBe(true));
  });

  it('ignores an offer the draft moved past, and never retries it', async () => {
    const { note, events } = await attach(adopting);
    engine.revision = 2;
    engine.text = 'typed more';

    emitSaved({
      token: note.token,
      outcome: outcome({ stamp: 1, revision: 1, offered: 'merged' }),
    });

    expect(events.offered).not.toHaveBeenCalled();
    expect(note.savedSource).toBe('base');
    expect(note.idle).toBe(false);
  });

  it('treats an offer equal to the draft as held, never as refused', async () => {
    const { note, events } = await attach();
    engine.revision = 1;
    engine.text = 'merged';

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, offered: 'merged' }) });

    expect(events.offered).not.toHaveBeenCalled();
    expect(note.savedSource).toBe('merged');
    expect(note.idle).toBe(true);
  });

  it('leaves a refused offer to the editor and does not record it as saved', async () => {
    const { note, events } = await attach(() => 'refused');
    engine.revision = 1;

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, offered: 'merged' }) });

    expect(events.offered).toHaveBeenCalledOnce();
    expect(host.editorRequest).not.toHaveBeenCalled();
    expect(note.savedSource).toBe('base');
    expect(note.idle).toBe(false);
    expect(note.offerWaiting).toBe(false);
  });

  it('keeps an offer for later while composing and marks it waiting', async () => {
    const { note } = await attach(() => 'later');
    engine.revision = 1;

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, offered: 'merged' }) });

    expect(note.offerWaiting).toBe(true);
    expect(note.savedSource).toBe('base');
    expect(note.idle).toBe(false);
  });

  it('reports a save that recreated the note', async () => {
    const { note, landed } = await attach();

    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, recreated: true }) });

    expect(landed.map(({ recreated }) => recreated)).toEqual([true]);
  });
});

/* A timer save failed (stamp 1), then a checkpoint landed (stamp 2), and the failure's
 * event arrived last: applied on arrival, it re-raised the failure after the save. */
it('orders a failed timer save against the saves that follow it', async () => {
  const { note, order } = await attach();
  host.editorCheckpoint.mockResolvedValueOnce(outcome({ stamp: 2 }));
  const saving = note.checkpoint();
  await vi.waitFor(() => expect(host.editorCheckpoint).toHaveBeenCalled());
  emitSaved({
    token: note.token,
    outcome: outcome({ stamp: 1, saved: false, error: 'disk full' }),
  });
  await saving;
  expect(order).toEqual(['failed', 'saved']);
});

/* An outside change adopted into a clean draft (DesktopEditor.svelte `reload`): the host
 * saves the note, then reads back whichever note its attachment then holds. */
describe('reading the note back from disk', () => {
  it('attaches the note the host read back under a new token, after the save it reports', async () => {
    const { note, landed } = await attach();
    host.editorReload.mockResolvedValueOnce({
      opened: {
        token: note.token + 1,
        noteId: 'Note',
        snapshot: { source: 'outside', revision: 0 },
      },
      closed: outcome({ stamp: 1, saved: true }),
    });
    const reloaded = await AttachedNote.reload(note, {
      landed: (event) => landed.push(event),
      saveFailed: vi.fn(),
      deleted: vi.fn(),
    });

    expect(host.editorReload).toHaveBeenCalledWith(note.token);
    expect(note.attached).toBe(false);
    expect(reloaded.token).toBe(note.token + 1);
    expect(reloaded.savedSource).toBe('outside');
    expect(landed.map(({ toId, saved }) => [toId, saved])).toEqual([['Note', true]]);
  });

  /* The note changed under a dirty draft: the reload's save parked the draft, and the host
   * reads back the copy, never the original's outside bytes. */
  it('follows the conflict copy the save parked the draft in', async () => {
    const { note, landed } = await attach();
    emitSaved({ token: note.token, outcome: outcome({ stamp: 1, saved: false, noteId: 'Moved' }) });
    host.editorReload.mockResolvedValueOnce({
      opened: {
        token: note.token + 1,
        noteId: 'Moved (conflict)',
        snapshot: { source: 'draft', revision: 0 },
      },
      closed: outcome({ stamp: 2, noteId: 'Moved (conflict)', parked: true }),
    });
    const reloaded = await AttachedNote.reload(note, {
      landed: (event) => landed.push(event),
      saveFailed: vi.fn(),
      deleted: vi.fn(),
    });

    expect(landed.map(({ fromId, toId, keepsOriginal }) => [fromId, toId, keepsOriginal])).toEqual([
      ['Note', 'Moved', false],
      ['Moved', 'Moved (conflict)', true],
    ]);
    expect(reloaded.noteId).toBe('Moved (conflict)');
    expect(reloaded.savedSource).toBe('draft');
  });
});

/* The note was deleted in the app under the editor (the store ends the attachment): the
 * worker answers every later request `Deleted`, and asking it to resume would change nothing. */
it('reports a deleted note once and asks nothing more of the host', async () => {
  const { note, events } = await attach();
  host.editorRequest.mockClear();
  const ack: HostAck = {
    token: note.token,
    sequence: 1,
    accepted: 0,
    paused: true,
    error: { kind: 'Deleted', message: 'editor attachment was deleted' },
  };
  host.editorRequest.mockResolvedValueOnce(ack);
  const typed: HostRequest = {
    token: note.token,
    sequence: 1,
    operation: {
      Append: {
        previous_revision: 0,
        revision: 1,
        range: { start: 4, end: 4 },
        removed: '',
        inserted: '!',
      },
    },
  };
  // The page reads only the request of what it applied.
  note.send({ request: typed } as Applied);

  await vi.waitFor(() => expect(events.deleted).toHaveBeenCalledTimes(1));
  expect(host.editorRequest).toHaveBeenCalledTimes(1);
});
