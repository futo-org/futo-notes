import { afterEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.hoisted(() => vi.fn());
vi.mock('./index', () => ({ isTauri: true }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

const { openExternalUrl } = await import('./openExternalUrl');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openExternalUrl on desktop', () => {
  // RC-95: a raw plugin call carrying a lone surrogate never settles on WebKitGTK.
  it('hands the opener only a well-formed url', async () => {
    openUrl.mockResolvedValueOnce(undefined);

    openExternalUrl('https://futo.tech/a\uD800b?q=\uD83D\uDE00');

    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith('https://futo.tech/a\uFFFDb?q=\uD83D\uDE00'),
    );
  });

  // The Tauri opener rejects anything outside its scheme allowlist ("Not
  // allowed to open url futo.tech"). Unhandled, that rejection reached the
  // global handler and was filed as a crash report.
  it('logs an opener rejection instead of leaving it unhandled', async () => {
    const failure = new Error('Not allowed to open url futo.tech');
    openUrl.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    openExternalUrl('futo.tech');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), failure));
    expect(openUrl).toHaveBeenCalledWith('futo.tech');
  });
});
