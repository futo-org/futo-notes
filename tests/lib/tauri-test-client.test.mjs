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
  constructor(window, timeoutCommandNumbers = []) {
    super();
    this.window = window;
    this.timeoutCommandNumbers = new Set(timeoutCommandNumbers);
    this.sent = [];
  }

  send(raw) {
    this.sent.push(raw);
    const { id, args } = JSON.parse(raw);
    const commandNumber = this.sent.length;

    Promise.resolve(runInNewContext(args.script, { window: this.window })).then(
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
