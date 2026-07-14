// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWatcherBatch, type WatcherBatchOptions } from './watcherBatch';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import type { FileChangeEvent } from '$lib/platform/types';

function makeOptions(overrides?: Partial<WatcherBatchOptions>): WatcherBatchOptions {
  return {
    onEvent: overrides?.onEvent ?? vi.fn(async () => {}),
    onBulkRefresh: overrides?.onBulkRefresh ?? vi.fn(async () => {}),
    suppressor: overrides?.suppressor ?? createWriteSuppressor(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('watcherBatch enqueue', () => {
  it('queues events and processes after 50ms debounce', async () => {
    const onEvent = vi.fn(async () => {});
    const opts = makeOptions({ onEvent });
    const batch = createWatcherBatch(opts);

    batch.enqueue({ type: 'change', filename: 'note.md' });
    expect(onEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'change', filename: 'note.md' });

    batch.destroy();
  });

  it('deduplicates events within the same batch, keeping the last', async () => {
    const onEvent = vi.fn(async () => {});
    const opts = makeOptions({ onEvent });
    const batch = createWatcherBatch(opts);

    batch.enqueue({ type: 'add', filename: 'note.md' });
    batch.enqueue({ type: 'change', filename: 'note.md' });
    batch.enqueue({ type: 'change', filename: 'other.md' });

    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ type: 'change', filename: 'note.md' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'change', filename: 'other.md' });

    batch.destroy();
  });

  it('triggers onBulkRefresh for batches >10 events', async () => {
    const onEvent = vi.fn(async () => {});
    const onBulkRefresh = vi.fn(async () => {});
    const opts = makeOptions({ onEvent, onBulkRefresh });
    const batch = createWatcherBatch(opts);

    for (let i = 0; i < 12; i++) {
      batch.enqueue({ type: 'change', filename: `note-${i}.md` });
    }

    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onBulkRefresh).toHaveBeenCalledTimes(1);
    const events = onBulkRefresh.mock.calls[0][0] as FileChangeEvent[];
    expect(events.length).toBe(12);

    batch.destroy();
  });

  it('processes exactly 10 events individually (boundary)', async () => {
    const onEvent = vi.fn(async () => {});
    const onBulkRefresh = vi.fn(async () => {});
    const opts = makeOptions({ onEvent, onBulkRefresh });
    const batch = createWatcherBatch(opts);

    for (let i = 0; i < 10; i++) {
      batch.enqueue({ type: 'change', filename: `note-${i}.md` });
    }

    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).toHaveBeenCalledTimes(10);
    expect(onBulkRefresh).not.toHaveBeenCalled();

    batch.destroy();
  });

  it('buffers events while sync is active', async () => {
    const onEvent = vi.fn(async () => {});
    const opts = makeOptions({ onEvent });
    const batch = createWatcherBatch(opts);

    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'note.md' });

    await vi.advanceTimersByTimeAsync(100);
    expect(onEvent).not.toHaveBeenCalled();

    batch.destroy();
  });

  it('does not coalesce events from separate debounce windows', async () => {
    const onEvent = vi.fn(async () => {});
    const opts = makeOptions({ onEvent });
    const batch = createWatcherBatch(opts);

    batch.enqueue({ type: 'add', filename: 'a.md' });
    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).toHaveBeenCalledTimes(1);

    batch.enqueue({ type: 'change', filename: 'b.md' });
    await vi.advanceTimersByTimeAsync(50);
    expect(onEvent).toHaveBeenCalledTimes(2);

    batch.destroy();
  });
});

describe('watcherBatch drainPostSync', () => {
  it('drains pending events after 500ms, filtering sync writes', async () => {
    const onBulkRefresh = vi.fn(async () => {});
    const suppressor = createWriteSuppressor();
    const opts = makeOptions({ onBulkRefresh, suppressor });
    const batch = createWatcherBatch(opts);

    suppressor.recordSyncWrite('synced.md');

    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'synced.md' });
    batch.enqueue({ type: 'change', filename: 'external.md' });

    batch.setSyncActive(false);
    batch.drainPostSync();

    await vi.advanceTimersByTimeAsync(500);
    expect(onBulkRefresh).toHaveBeenCalledTimes(1);
    const events = onBulkRefresh.mock.calls[0][0] as FileChangeEvent[];
    expect(events).toEqual([{ type: 'change', filename: 'external.md' }]);

    batch.destroy();
  });

  it('does nothing when all pending events are sync writes', async () => {
    const onBulkRefresh = vi.fn(async () => {});
    const suppressor = createWriteSuppressor();
    const opts = makeOptions({ onBulkRefresh, suppressor });
    const batch = createWatcherBatch(opts);

    suppressor.recordSyncWrite('synced.md');
    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'synced.md' });
    batch.setSyncActive(false);
    batch.drainPostSync();

    await vi.advanceTimersByTimeAsync(500);
    expect(onBulkRefresh).not.toHaveBeenCalled();

    batch.destroy();
  });

  it('cancels a previous drain timer when called again', async () => {
    const onBulkRefresh = vi.fn(async () => {});
    const suppressor = createWriteSuppressor();
    const opts = makeOptions({ onBulkRefresh, suppressor });
    const batch = createWatcherBatch(opts);

    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'a.md' });
    batch.setSyncActive(false);

    batch.drainPostSync();
    batch.drainPostSync();

    await vi.advanceTimersByTimeAsync(500);
    expect(onBulkRefresh).toHaveBeenCalledTimes(1);

    batch.destroy();
  });

  it('filters local writes buffered before sync started (expired TTL)', async () => {
    const onBulkRefresh = vi.fn(async () => {});
    const suppressor = createWriteSuppressor();
    const opts = makeOptions({ onBulkRefresh, suppressor });
    const batch = createWatcherBatch(opts);

    suppressor.recordWrite('new note.md');

    await vi.advanceTimersByTimeAsync(1500);

    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'new note.md' });
    batch.enqueue({ type: 'change', filename: 'external.md' });

    batch.setSyncActive(false);
    batch.drainPostSync();

    await vi.advanceTimersByTimeAsync(500);
    expect(onBulkRefresh).toHaveBeenCalledTimes(1);
    const events = onBulkRefresh.mock.calls[0][0] as FileChangeEvent[];
    expect(events).toEqual([{ type: 'change', filename: 'external.md' }]);

    batch.destroy();
  });
});

describe('watcherBatch destroy', () => {
  it('clears all timers and queues', async () => {
    const onEvent = vi.fn(async () => {});
    const opts = makeOptions({ onEvent });
    const batch = createWatcherBatch(opts);

    batch.enqueue({ type: 'change', filename: 'note.md' });
    batch.destroy();

    await vi.advanceTimersByTimeAsync(100);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
