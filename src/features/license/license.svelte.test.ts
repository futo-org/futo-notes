// @vitest-environment jsdom
// The toast bus schedules its dismissal on a timer, so this needs a DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LicenseActionResult, LicenseView } from '$lib/platform/license';

const UNLICENSED: LicenseView = { state: 'unlicensed', issuedAt: null, expiresAt: null };
const LICENSED: LicenseView = {
  state: 'licensed',
  issuedAt: '2026-06-15T12:00:00Z',
  expiresAt: '2029-06-15T12:00:00Z',
};

const platform = vi.hoisted(() => ({
  readLicenseStatus: vi.fn(),
  submitLicenseKey: vi.fn(),
  clearLicense: vi.fn(),
  readLicenseLinks: vi.fn(),
  takePendingLicenseLink: vi.fn(),
  nudge: null as null | (() => void),
  subscribeDelay: null as null | Promise<void>,
}));

vi.mock('$lib/platform/license', () => ({
  UNLICENSED: { state: 'unlicensed', issuedAt: null, expiresAt: null },
  readLicenseStatus: platform.readLicenseStatus,
  submitLicenseKey: platform.submitLicenseKey,
  clearLicense: platform.clearLicense,
  readLicenseLinks: platform.readLicenseLinks,
  takePendingLicenseLink: platform.takePendingLicenseLink,
  // Capture the handler so a test can fire a link nudge the way Rust does.
  // `subscribeDelay` lets a test hold the subscription open to prove the drain
  // waits for it.
  subscribeLicenseLinks: async (handler: () => void) => {
    if (platform.subscribeDelay) await platform.subscribeDelay;
    platform.nudge = handler;
    return () => {
      platform.nudge = null;
    };
  },
}));

const opened: string[] = [];
vi.mock('$lib/platform/openExternalUrl', () => ({
  openExternalUrl: (url: string) => opened.push(url),
}));

// `vi.resetModules()` rebuilds the whole module graph, so the toast bus and the
// localization module must come from that SAME graph — the copies this file
// imported at the top are different instances the model never writes to.
let currentToastMessage: () => string = () => '';

async function freshModel() {
  vi.resetModules();
  const [model, toasts, localization] = await Promise.all([
    import('./license.svelte'),
    import('$shared/notifications/toastBus.svelte'),
    import('$shared/localization'),
  ]);
  currentToastMessage = toasts.currentToastMessage;
  localization.desktopLocalization.setSelectedLanguageTag('en');
  return model.license;
}

/** Lets the un-awaited promises inside `start()` / actions settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  opened.length = 0;
  platform.nudge = null;
  platform.subscribeDelay = null;
  platform.readLicenseStatus.mockResolvedValue(UNLICENSED);
  platform.readLicenseLinks.mockResolvedValue({ buy: 'https://buy.example', support: 'mailto:x' });
  platform.takePendingLicenseLink.mockResolvedValue(null);
  platform.clearLicense.mockResolvedValue(UNLICENSED);
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('starting up', () => {
  // M5/M1: the license is read once into reactive state, never per render, and
  // never on the path that blocks the first paint.
  it('reads the status once, however many times it is started', async () => {
    const license = await freshModel();

    license.start();
    license.start();
    await settle();

    expect(platform.readLicenseStatus).toHaveBeenCalledTimes(1);
  });

  it('applies the stored status and the crate-owned links', async () => {
    platform.readLicenseStatus.mockResolvedValue(LICENSED);
    const license = await freshModel();

    license.start();
    await settle();

    expect(license.view).toEqual(LICENSED);
    expect(license.links.buy).toBe('https://buy.example');
  });

  // A link that cold-started the app was applied by Rust and parked; the shell
  // drains it once it can toast.
  it('drains a link that arrived before the shell existed', async () => {
    platform.takePendingLicenseLink.mockResolvedValue({
      outcome: 'activated',
      view: LICENSED,
    } satisfies LicenseActionResult);
    const license = await freshModel();

    license.start();
    await settle();

    expect(license.view).toEqual(LICENSED);
    expect(currentToastMessage()).toBe('License activated');
  });

  it('does not let the startup snapshot overwrite a license activated while it was loading', async () => {
    let finishRead: (view: LicenseView) => void = () => {};
    platform.readLicenseStatus.mockReturnValue(
      new Promise<LicenseView>((resolve) => {
        finishRead = resolve;
      }),
    );
    platform.takePendingLicenseLink.mockResolvedValue({
      outcome: 'activated',
      view: LICENSED,
    } satisfies LicenseActionResult);
    const license = await freshModel();

    license.start();
    await settle();
    expect(license.view).toEqual(LICENSED);

    finishRead(UNLICENSED);
    await settle();

    expect(license.view).toEqual(LICENSED);
  });
});

describe('a link arriving while the app runs', () => {
  it('reports the outcome it drains', async () => {
    const license = await freshModel();
    license.start();
    await settle();

    platform.takePendingLicenseLink.mockResolvedValue({
      outcome: 'invalid',
      view: UNLICENSED,
    } satisfies LicenseActionResult);
    platform.nudge?.();
    await settle();

    expect(currentToastMessage()).toBe("This license link isn't valid");
  });

  // The regression: the outcome used to ride on the event payload AND stay
  // parked, so the next launch re-toasted a link the user had already seen.
  // Draining is the only read, so a nudge with an empty inbox says nothing.
  it('says nothing when the inbox is already empty', async () => {
    const license = await freshModel();
    license.start();
    await settle();
    vi.runAllTimers(); // clear any toast from startup

    platform.takePendingLicenseLink.mockResolvedValue(null);
    platform.nudge?.();
    await settle();

    expect(currentToastMessage()).toBe('');
  });
});

describe('the subscribe-then-drain order', () => {
  // The race this pins: the listener is attached through a dynamic import, so a
  // drain that runs first leaves a link arriving in the gap reported by nobody
  // — parked until the next launch. The drain must wait for the subscription.
  it('does not drain until the listener is attached', async () => {
    let attach: () => void = () => {};
    platform.subscribeDelay = new Promise<void>((resolve) => {
      attach = resolve;
    });
    const license = await freshModel();

    license.start();
    await settle();
    expect(platform.takePendingLicenseLink).not.toHaveBeenCalled();

    attach();
    await settle();
    expect(platform.takePendingLicenseLink).toHaveBeenCalledTimes(1);
  });

  // NotesShell stops the model on unmount; a remount has to read the license
  // again rather than keep whatever this singleton last saw.
  it('reads again after it has been stopped', async () => {
    const license = await freshModel();

    const stop = license.start();
    await settle();
    stop();

    license.start();
    await settle();

    expect(platform.readLicenseStatus).toHaveBeenCalledTimes(2);
  });
});

describe('entering a key', () => {
  it.each([
    ['invalid', "This license key isn't valid"],
    ['offline', 'Connect to the internet to activate this key'],
  ] as const)('reports %s with the specified message', async (outcome, message) => {
    platform.submitLicenseKey.mockResolvedValue({ outcome, view: UNLICENSED });
    const license = await freshModel();
    license.start();
    await settle();

    const accepted = await license.enterKey('whatever');

    expect(accepted).toBe(false);
    expect(currentToastMessage()).toBe(message);
    expect(license.view).toEqual(UNLICENSED);
  });

  it('accepts a good key, updates state and confirms', async () => {
    platform.submitLicenseKey.mockResolvedValue({ outcome: 'activated', view: LICENSED });
    const license = await freshModel();
    license.start();
    await settle();

    const accepted = await license.enterKey('FN-AB12-…');

    expect(accepted).toBe(true);
    expect(license.view).toEqual(LICENSED);
    expect(currentToastMessage()).toBe('License activated');
  });

  // The bare-key path makes a network request. A second click while it is in
  // flight must not start a second one — the crate forbids a retry.
  it('refuses a second submission while one is in flight', async () => {
    let release: (value: LicenseActionResult) => void = () => {};
    platform.submitLicenseKey.mockReturnValue(
      new Promise<LicenseActionResult>((resolve) => {
        release = resolve;
      }),
    );
    const license = await freshModel();
    license.start();
    await settle();

    const first = license.enterKey('FN-AB12-…');
    const second = await license.enterKey('FN-AB12-…');

    expect(second).toBe(false);
    expect(platform.submitLicenseKey).toHaveBeenCalledTimes(1);

    release({ outcome: 'activated', view: LICENSED });
    expect(await first).toBe(true);
  });

  // A thrown command must not leave the field spinning forever.
  it('clears the busy flag when the command throws', async () => {
    platform.submitLicenseKey.mockRejectedValue(new Error('ipc died'));
    const license = await freshModel();
    license.start();
    await settle();

    expect(await license.enterKey('FN-AB12-…')).toBe(false);
    expect(license.busy).toBe(false);
  });
});

describe('the other row actions', () => {
  it('returns to Unlicensed on remove', async () => {
    platform.readLicenseStatus.mockResolvedValue(LICENSED);
    const license = await freshModel();
    license.start();
    await settle();

    await license.remove();

    expect(license.view).toEqual(UNLICENSED);
  });

  // Buy opens the SYSTEM browser at the crate-owned URL — never a webview, and
  // never a URL this shell assembled.
  it('opens the buy and support URLs it was given', async () => {
    const license = await freshModel();
    license.start();
    await settle();

    license.openBuyPage();
    license.openSupport();

    expect(opened).toEqual(['https://buy.example', 'mailto:x']);
  });

  it('opens nothing before the links have loaded', async () => {
    const license = await freshModel();

    license.openBuyPage();

    expect(opened).toEqual([]);
  });
});
