import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from '@tauri-apps/api/core';
import { onFileChange } from './events';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockClear();
});

describe('file watcher startup', () => {
  it('starts the filesystem watcher once across repeated subscriptions', async () => {
    const unsubscribeFirst = onFileChange(() => {});
    // Let the first fs_start_watcher invoke resolve before subscribing again —
    // a second start would register duplicate OS watchers and double-fire
    // every file event.
    await Promise.resolve();
    await Promise.resolve();

    const unsubscribeSecond = onFileChange(() => {});
    await Promise.resolve();

    const startCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'fs_start_watcher');
    expect(startCalls).toHaveLength(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });
});
