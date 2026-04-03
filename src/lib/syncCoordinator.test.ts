// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncCoordinator, type SyncCoordinatorDeps, type SyncCoordinatorUI } from './syncCoordinator';
import type { WatcherBatch } from './watcherBatch';

function makeDeps(overrides?: Partial<SyncCoordinatorDeps>): SyncCoordinatorDeps {
  return {
    watcherBatch: {
      enqueue: vi.fn(),
      drainPostSync: vi.fn(),
      setSyncActive: vi.fn(),
      destroy: vi.fn(),
    } as WatcherBatch,
    getEditVersion: overrides?.getEditVersion ?? (() => 0),
    isSavePending: overrides?.isSavePending ?? (() => false),
    isComposing: overrides?.isComposing ?? (() => false),
    getLastEditTime: overrides?.getLastEditTime ?? (() => 0),
    ...overrides,
  };
}

function makeUI(overrides?: Partial<SyncCoordinatorUI>): SyncCoordinatorUI {
  return {
    onStatusMessage: overrides?.onStatusMessage ?? vi.fn(),
    onIndicatorChange: overrides?.onIndicatorChange ?? vi.fn(),
    onOfflineChange: overrides?.onOfflineChange ?? vi.fn(),
  };
}

describe('syncCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('shouldDeferSync', () => {
    it('defers when a save is pending', () => {
      const deps = makeDeps({ isSavePending: () => true });
      const coord = createSyncCoordinator(deps, makeUI());
      expect(coord.shouldDeferSync()).toBe(true);
      coord.destroy();
    });

    it('defers when the editor is composing (IME)', () => {
      const deps = makeDeps({ isComposing: () => true });
      const coord = createSyncCoordinator(deps, makeUI());
      expect(coord.shouldDeferSync()).toBe(true);
      coord.destroy();
    });

    it('defers when the last edit was less than 1 second ago', () => {
      const now = Date.now();
      const deps = makeDeps({ getLastEditTime: () => now - 500 });
      const coord = createSyncCoordinator(deps, makeUI());
      expect(coord.shouldDeferSync()).toBe(true);
      coord.destroy();
    });

    it('does not defer when idle', () => {
      const deps = makeDeps({ getLastEditTime: () => Date.now() - 2000 });
      const coord = createSyncCoordinator(deps, makeUI());
      expect(coord.shouldDeferSync()).toBe(false);
      coord.destroy();
    });
  });

  describe('onSyncStateChange', () => {
    it('sets syncActive on watcher batch when sync starts', () => {
      const deps = makeDeps();
      const coord = createSyncCoordinator(deps, makeUI());
      coord.onSyncStateChange(true);
      expect(deps.watcherBatch.setSyncActive).toHaveBeenCalledWith(true);
      coord.destroy();
    });

    it('captures edit version at sync start', () => {
      let editVersion = 5;
      const deps = makeDeps({ getEditVersion: () => editVersion });
      const coord = createSyncCoordinator(deps, makeUI());
      coord.onSyncStateChange(true);
      expect(coord.getSyncStartEditVersion()).toBe(5);

      editVersion = 10;
      // getSyncStartEditVersion should still return the captured value
      expect(coord.getSyncStartEditVersion()).toBe(5);
      coord.destroy();
    });

    it('shows "Syncing..." status message on sync start', () => {
      const onStatusMessage = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onStatusMessage }));
      coord.onSyncStateChange(true);
      expect(onStatusMessage).toHaveBeenCalledWith('Syncing...');
      coord.destroy();
    });

    it('shows sync indicator on start, hides after 400ms on stop', () => {
      const onIndicatorChange = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onIndicatorChange }));

      coord.onSyncStateChange(true);
      expect(onIndicatorChange).toHaveBeenCalledWith(true);

      onIndicatorChange.mockClear();
      coord.onSyncStateChange(false);
      // Not hidden yet — minimum 400ms display
      expect(onIndicatorChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);
      expect(onIndicatorChange).toHaveBeenCalledWith(false);

      coord.destroy();
    });

    it('drains post-sync watcher batch on sync end', () => {
      const deps = makeDeps();
      const coord = createSyncCoordinator(deps, makeUI());
      coord.onSyncStateChange(false);
      expect(deps.watcherBatch.drainPostSync).toHaveBeenCalled();
      coord.destroy();
    });

    it('clears a pending status-clear timer when sync starts again', () => {
      const onStatusMessage = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onStatusMessage }));

      // Start and stop a sync to create a status-clear timer scenario
      coord.onSyncStateChange(true);
      coord.onSyncStateChange(false);

      // Start another sync immediately — should clear any pending timer
      onStatusMessage.mockClear();
      coord.onSyncStateChange(true);
      expect(onStatusMessage).toHaveBeenCalledWith('Syncing...');

      coord.destroy();
    });
  });

  describe('onOfflineChange', () => {
    it('forwards offline state to UI callback', () => {
      const onOfflineChange = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onOfflineChange }));
      coord.onOfflineChange(true);
      expect(onOfflineChange).toHaveBeenCalledWith(true);
      coord.onOfflineChange(false);
      expect(onOfflineChange).toHaveBeenCalledWith(false);
      coord.destroy();
    });
  });

  describe('setStatusWithTimeout', () => {
    it('sets a status message and clears it after the timeout', () => {
      const onStatusMessage = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onStatusMessage }));

      coord.setStatusWithTimeout('Synced 25 notes', 3000);
      expect(onStatusMessage).toHaveBeenCalledWith('Synced 25 notes');

      onStatusMessage.mockClear();
      vi.advanceTimersByTime(3000);
      expect(onStatusMessage).toHaveBeenCalledWith('');

      coord.destroy();
    });

    it('clear timer is cancelled when sync starts', () => {
      const onStatusMessage = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onStatusMessage }));

      coord.setStatusWithTimeout('Synced 25 notes', 3000);
      // Sync starts before the 3s timer fires
      coord.onSyncStateChange(true);

      onStatusMessage.mockClear();
      vi.advanceTimersByTime(3000);
      // The old "clear" timer should not fire (it was cleared by onSyncStateChange)
      expect(onStatusMessage).not.toHaveBeenCalledWith('');

      coord.destroy();
    });
  });

  describe('destroy', () => {
    it('clears indicator timer so it does not fire after teardown', () => {
      const onIndicatorChange = vi.fn();
      const coord = createSyncCoordinator(makeDeps(), makeUI({ onIndicatorChange }));

      coord.onSyncStateChange(true);
      coord.onSyncStateChange(false);
      coord.destroy();

      onIndicatorChange.mockClear();
      vi.advanceTimersByTime(2000);
      expect(onIndicatorChange).not.toHaveBeenCalled();
    });
  });
});
