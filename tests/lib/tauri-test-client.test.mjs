import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { TauriTestClient, waitForTestHooks } from './tauri-test-client.mjs';

class FakeWs extends EventEmitter {
  constructor(responses) {
    super();
    this.responses = [...responses];
    this.sent = [];
  }

  send(raw) {
    this.sent.push(raw);
    const { id } = JSON.parse(raw);
    const response = this.responses.shift();
    Promise.resolve().then(() => {
      if (response instanceof Error) {
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              id,
              success: false,
              error: response.message,
            }),
          ),
        );
        return;
      }
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            id,
            success: true,
            data: { result: response },
          }),
        ),
      );
    });
  }
}

class EvaluatingWs extends EventEmitter {
  constructor(window, timeoutCommandNumbers = [], extraGlobals = {}) {
    super();
    this.window = window;
    this.timeoutCommandNumbers = new Set(timeoutCommandNumbers);
    this.extraGlobals = extraGlobals;
    this.sent = [];
  }

  send(raw) {
    this.sent.push(raw);
    const { id, args } = JSON.parse(raw);
    const commandNumber = this.sent.length;

    Promise.resolve(
      runInNewContext(args.script, { window: this.window, ...this.extraGlobals }),
    ).then(
      (result) => {
        const response = this.timeoutCommandNumbers.has(commandNumber)
          ? { id, success: false, error: 'Script execution timeout' }
          : { id, success: true, data: { result } };
        this.emit('message', Buffer.from(JSON.stringify(response)));
      },
      (error) => {
        this.emit(
          'message',
          Buffer.from(JSON.stringify({ id, success: false, error: error.message })),
        );
      },
    );
  }
}

function createClient(ws) {
  return new TauriTestClient({ name: 'client-a', platform: 'desktop', ws });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTextArea {
  constructor(onInput) {
    this.value = '';
    this.focused = false;
    this.onInput = onInput;
  }

  focus() {
    this.focused = true;
  }

  dispatchEvent() {
    this.onInput(this.value);
    return true;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
  }
}

/**
 * A page double for the new-note editor: records the order of the page-side
 * calls the client makes, and models the two app behaviors the scenarios rely
 * on — a title input arms a pending save, and a sync persists the note.
 */
function createNewNotePage() {
  const events = [];
  const state = { originalId: null, title: 'Untitled', savePending: false, editorContent: '' };
  const titleInput = new FakeTextArea((value) => {
    events.push(`title:${value}`);
    state.title = value;
    state.savePending = true;
  });
  const window = {
    location: { hash: '#/note/new' },
    __notesShellTest: {
      typeInEditor(text) {
        events.push(`type:${text}`);
        state.editorContent = text;
        return text;
      },
      getState: () => ({ ...state }),
    },
    __testSync: {
      async syncNow() {
        events.push('syncNow');
        // The sync's own flush persists the note. It must NOT be visible in the
        // pre-sync snapshot — that was captured before this ran.
        state.originalId = 'typed note';
        state.savePending = false;
        return { summary: { uploaded: 1 } };
      },
    },
  };
  const globals = {
    document: { querySelector: (selector) => (selector === '.title-input' ? titleInput : {}) },
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
  };
  return { window, globals, events, state, titleInput };
}

describe('waitForTestHooks', () => {
  it('retries transient execute_js failures while the webview starts', async () => {
    const ws = new FakeWs([
      new Error('Script execution timeout'),
      JSON.stringify({ testSync: 'object', notesShell: 'object' }),
    ]);

    await expect(
      waitForTestHooks(ws, 'client-a', {
        initialDelayMs: 0,
        attempts: 2,
        intervalMs: 0,
      }),
    ).resolves.toBeUndefined();
    expect(ws.sent).toHaveLength(2);
  });

  it('retries while the bridge is available before the main window', async () => {
    const ws = new FakeWs([
      new Error("Window 'main' not found"),
      JSON.stringify({ testSync: 'object', notesShell: 'object' }),
    ]);

    await expect(
      waitForTestHooks(ws, 'client-a', {
        initialDelayMs: 0,
        attempts: 2,
        intervalMs: 0,
      }),
    ).resolves.toBeUndefined();
    expect(ws.sent).toHaveLength(2);
  });

  it('fails immediately when the startup probe returns a non-timeout error', async () => {
    const ws = new FakeWs([
      new Error('startup probe syntax error'),
      JSON.stringify({ testSync: 'object', notesShell: 'object' }),
    ]);

    await expect(
      waitForTestHooks(ws, 'client-a', {
        initialDelayMs: 0,
        attempts: 2,
        intervalMs: 0,
      }),
    ).rejects.toThrow('startup probe syntax error');
    expect(ws.sent).toHaveLength(1);
  });
});

describe('TauriTestClient bridge retries', () => {
  it('retries a read-only webview expression after bridge timeouts', async () => {
    const ws = new FakeWs([
      new Error('Script execution timeout'),
      new Error('Script execution timeout'),
      ['first note', 'second note'],
    ]);
    const client = createClient(ws);

    await expect(client.readWebview('window.__sidebarTitles', 'sidebar titles')).resolves.toEqual([
      'first note',
      'second note',
    ]);
    expect(ws.sent).toHaveLength(3);
  });

  it('fails a read immediately when the bridge returns a non-timeout error', async () => {
    const ws = new FakeWs([new Error('webview evaluation failed'), '# late content']);
    const client = createClient(ws);

    await expect(client.readNote('note')).rejects.toThrow('webview evaluation failed');
    expect(ws.sent).toHaveLength(1);
  });

  it('runs a mutation once when its first kickoff response times out', async () => {
    let writeCount = 0;
    const window = {
      __testNotes: {
        writeNote() {
          writeCount += 1;
          return 'written';
        },
      },
    };
    const ws = new EvaluatingWs(window, [1]);
    const client = createClient(ws);

    await expect(client.writeNote('note', '# content')).resolves.toBe('written');
    expect(writeCount).toBe(1);
  });

  it('stops polling a mutation after three consecutive bridge timeouts', async () => {
    const ws = new FakeWs([
      'started',
      new Error('Script execution timeout'),
      new Error('Script execution timeout'),
      new Error('Script execution timeout'),
      { done: true, value: 'late success' },
    ]);
    const client = createClient(ws);

    await expect(client.writeNote('note', '# content')).rejects.toThrow(
      'failed after 3 bridge timeout attempts',
    );
    expect(ws.sent).toHaveLength(4);
  });
});

describe('TauriTestClient editor flows', () => {
  it('opens a new note only once the fresh new-note session is live', async () => {
    // The route flip starts the load; the session still shows the previous note
    // until the loader has flushed and seeded. Returning early lets a caller
    // type a title into — and save — the wrong note.
    const state = {
      originalId: 'previous note',
      title: 'previous note',
      savePending: false,
      editorContent: '# previous',
    };
    const window = {
      location: { hash: '#/' },
      __notesShellTest: { getState: () => ({ ...state }) },
    };
    const ws = new EvaluatingWs(window, [], { document: { querySelector: () => ({}) } });
    const client = createClient(ws);

    let settled = false;
    const opening = client.openNewNote().then(() => {
      settled = true;
    });

    await sleep(300);
    expect(window.location.hash).toBe('#/note/new');
    expect(settled).toBe(false);

    state.originalId = null;
    state.title = 'Untitled';
    await opening;
    expect(settled).toBe(true);
  });

  it('snapshots the unsaved note state in the same page task as syncNow', async () => {
    const page = createNewNotePage();
    const ws = new EvaluatingWs(page.window, [], page.globals);
    const client = createClient(ws);

    const result = await client.composeNoteAndSyncNow('typed note', '# body');

    // One page task, in this order — nothing can save between the arming and the
    // sync request, so the snapshot is evidence and not a race.
    expect(page.events).toEqual(['type:# body', 'title:typed note', 'syncNow']);
    expect(result.preSync).toEqual({
      originalId: null,
      savePending: true,
      editorContent: '# body',
      title: 'typed note',
    });
    expect(result.summary.uploaded).toBe(1);
    expect(page.titleInput.focused).toBe(true);
  });
});
