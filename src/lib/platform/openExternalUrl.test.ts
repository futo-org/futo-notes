import { afterEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./index', () => ({ isTauri: true }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));
vi.mock('./tauri/invoke', () => ({ invoke }));

const { openExternalUrl } = await import('./openExternalUrl');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('openExternalUrl on desktop', () => {
  // RC-95: a raw plugin call carrying a lone surrogate never settles on WebKitGTK.
  it('hands the opener only a well-formed url', async () => {
    vi.stubEnv('DEV', false);
    openUrl.mockResolvedValueOnce(undefined);

    openExternalUrl('https://futo.tech/a\uD800b?q=😀');

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://futo.tech/a�b?q=😀'));
  });

  // The Tauri opener rejects anything outside its scheme allowlist ("Not
  // allowed to open url futo.tech"). Unhandled, that rejection reached the
  // global handler and was filed as a crash report.
  it('logs an opener rejection instead of leaving it unhandled', async () => {
    vi.stubEnv('DEV', false);
    const failure = new Error('Not allowed to open url futo.tech');
    openUrl.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    openExternalUrl('futo.tech');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), failure));
    expect(openUrl).toHaveBeenCalledWith('futo.tech');
  });

  // A dev build opens it behind the developer's window instead (dev_open_url.rs).
  it('sends a dev build through dev_open_url, never the opener', async () => {
    vi.stubEnv('DEV', true);
    invoke.mockResolvedValueOnce(undefined);

    openExternalUrl('https://futo.tech/a\uD800b');

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('dev_open_url', { url: 'https://futo.tech/a�b' }),
    );
    expect(openUrl).not.toHaveBeenCalled();
  });
});
