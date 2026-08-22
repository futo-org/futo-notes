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
    isDrainExempt: overrides?.isDrainExempt,
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
  it('carries a paired rename through without decomposing it', async () => {
    const onEvent = vi.fn(async () => {});
    const batch = createWatcherBatch(makeOptions({ onEvent }));

    batch.enqueue({ type: 'rename', filename: 'New.md', from: 'Old.md' });
    await vi.advanceTimersByTimeAsync(50);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'rename',
      filename: 'New.md',
      from: 'Old.md',
    });
    batch.destroy();
  });

  it('does not let a destination change replace a paired rename', async () => {
    const onEvent = vi.fn(async () => {});
    const batch = createWatcherBatch(makeOptions({ onEvent }));

    batch.enqueue({ type: 'rename', filename: 'New.md', from: 'Old.md' });
    batch.enqueue({ type: 'change', filename: 'New.md' });
    await vi.advanceTimersByTimeAsync(50);

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'rename', filename: 'New.md', from: 'Old.md' },
      { type: 'change', filename: 'New.md' },
    ]);
    batch.destroy();
  });

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

  it('keeps an exempt active-note change while filtering suppressed background changes', async () => {
    const onBulkRefresh = vi.fn(async () => {});
    const suppressor = createWriteSuppressor();
    const opts = makeOptions({
      onBulkRefresh,
      suppressor,
      isDrainExempt: (event) => event.type === 'change' && event.filename === 'active.md',
    });
    const batch = createWatcherBatch(opts);

    suppressor.recordSyncWrite('active.md');
    suppressor.recordSyncWrite('background.md');
    batch.setSyncActive(true);
    batch.enqueue({ type: 'change', filename: 'active.md' });
    batch.enqueue({ type: 'change', filename: 'background.md' });
    batch.setSyncActive(false);
    batch.drainPostSync();

    await vi.advanceTimersByTimeAsync(500);
    expect(onBulkRefresh).toHaveBeenCalledExactlyOnceWith([
      { type: 'change', filename: 'active.md' },
    ]);

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

  it('keeps external events while filtering exact sync-write echoes', async () => {
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
