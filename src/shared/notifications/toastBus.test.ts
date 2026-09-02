// @vitest-environment jsdom
// The bus schedules its dismissal on `window.setTimeout`, so it needs a DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOAST_DURATION_MS, currentToastMessage, showGlobalToast } from './toastBus.svelte';

describe('toastBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain whatever timer the last toast left behind so the module's
    // single-slot state does not leak into the next test.
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    vi.useRealTimers();
  });

  // Five seconds, not three. A sync failure toast is the only warning a user
  // gets that their notes folder has gone missing (github#44), and the message
  // names a full path before telling them where to fix it — a screenshot taken
  // 3.4s after that failure caught nothing but the ⚠ indicator.
  it('holds a message for five seconds, then clears it', () => {
    showGlobalToast('Sync error: Something the user has to read');
    expect(currentToastMessage()).toBe('Sync error: Something the user has to read');

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(currentToastMessage()).toBe('Sync error: Something the user has to read');

    vi.advanceTimersByTime(1);
    expect(currentToastMessage()).toBe('');
    expect(TOAST_DURATION_MS).toBe(5000);
  });

  // One slot: a second message replaces the first and restarts the clock, so
  // the newer message still gets its full read time rather than inheriting the
  // remainder of the older one's.
  it('a second toast replaces the first and restarts the clock', () => {
    showGlobalToast('first');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 500);
    showGlobalToast('second');

    expect(currentToastMessage()).toBe('second');
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(currentToastMessage()).toBe('second');

    vi.advanceTimersByTime(1);
    expect(currentToastMessage()).toBe('');
  });
});
