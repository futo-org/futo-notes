import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from '@tauri-apps/api/core';
import { onFileChange } from '../tauri';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockClear();
});

describe('file watcher startup', () => {
  it('starts the filesystem watcher once across repeated subscriptions', async () => {
    let resolveStart!: () => void;
    mockInvoke.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const unsubscribeFirst = onFileChange(() => {});
    const unsubscribeSecond = onFileChange(() => {});

    const startCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'fs_start_watcher');
    expect(startCalls).toHaveLength(1);

    resolveStart();
    await Promise.resolve();
    unsubscribeFirst();
    unsubscribeSecond();
  });
});
