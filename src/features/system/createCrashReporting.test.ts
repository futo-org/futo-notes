import { beforeEach, describe, expect, it, vi } from 'vitest';

const savePreferences = vi.fn();
vi.mock('$shared/state/appState', () => ({
  getCachedPreferences: () => ({ crashReporting: { enabled: true, alwaysSend: false } }),
  savePreferences: (...args: unknown[]) => savePreferences(...args),
}));

const sendAllPendingReports = vi.fn();
const discardAllPendingReports = vi.fn();
vi.mock('./crashReporter', () => ({
  discardAllPendingReports: () => discardAllPendingReports(),
  getLastSendError: () => null,
  loadPendingReports: vi.fn(),
  sendAllPendingReports: (...args: unknown[]) => sendAllPendingReports(...args),
}));

vi.mock('./crashHandler', () => ({ flushCrashQueue: vi.fn(), setAppVersion: vi.fn() }));
vi.mock('$lib/platform', () => ({ getPlatformFS: vi.fn(), hasFileSystem: false }));

import { createCrashReporting } from './createCrashReporting.svelte';

// Crash #1788: the dialog fires `resolve` un-awaited, so a vault the app cannot
// write to must end in a message, never a rejection.
describe('createCrashReporting.resolve when the preference cannot be saved', () => {
  const denied = new Error('Permission denied (os error 13)');
  const showToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    savePreferences.mockResolvedValue(false);
    sendAllPendingReports.mockResolvedValue({ sent: 1, failed: 0 });
    discardAllPendingReports.mockResolvedValue(undefined);
  });

  it('still sends the reports the user chose to send', async () => {
    await createCrashReporting(showToast).resolve({ action: 'send', alwaysSend: true });

    expect(sendAllPendingReports).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      path: 'crashReporting.sentCount',
      arguments: { count: 1 },
    });
  });

  it('says the choice was not saved', async () => {
    await createCrashReporting(showToast).resolve({ action: 'discard', alwaysSend: false });

    expect(showToast).toHaveBeenCalledWith({ path: 'settings.saveFailed' });
    expect(showToast).not.toHaveBeenCalledWith({ path: 'crashReporting.disabled' });
  });

  // Reporting is off once the preference saved, so leftover reports are never
  // offered again — failing to delete them is not worth an error.
  it('does not reject when the pending reports cannot be deleted', async () => {
    savePreferences.mockResolvedValue(true);
    discardAllPendingReports.mockRejectedValue(denied);

    await createCrashReporting(showToast).resolve({ action: 'discard', alwaysSend: false });

    expect(showToast).toHaveBeenCalledWith({ path: 'crashReporting.disabled' });
  });
});
