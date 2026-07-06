import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForTestHooks } from '../tests/lib/tauri-test-client.mjs';

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
    queueMicrotask(() => {
      if (response instanceof Error) {
        this.emit('message', Buffer.from(JSON.stringify({
          id,
          success: false,
          error: response.message,
        })));
        return;
      }
      this.emit('message', Buffer.from(JSON.stringify({
        id,
        success: true,
        data: { result: response },
      })));
    });
  }
}

describe('waitForTestHooks', () => {
  it('retries transient execute_js failures while the webview starts', async () => {
    const ws = new FakeWs([
      new Error('Script execution timeout'),
      JSON.stringify({ testSync: 'object', notesShell: 'object' }),
    ]);

    await expect(waitForTestHooks(ws, 'client-a', {
      initialDelayMs: 0,
      attempts: 2,
      intervalMs: 0,
    })).resolves.toBeUndefined();
    expect(ws.sent).toHaveLength(2);
  });
});
