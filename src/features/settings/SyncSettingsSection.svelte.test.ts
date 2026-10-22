// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { registeredVerbs } from '$app/puppet/puppetRegistry';

import SyncSettingsSection from './SyncSettingsSection.svelte';
import type { SyncSettings } from './createSyncSettings.svelte';

function makeSync(status = '', overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    url: 'https://notes.example.com',
    password: '',
    busy: false,
    status,
    lastSyncedAt: null,
    connected: true,
    passwordSaved: true,
    connecting: false,
    connectPhase: '',
    connectError: '',
    connect: vi.fn(async () => {}),
    cancelConnect: vi.fn(),
    resetConnection: vi.fn(async () => {}),
    forgetPassword: vi.fn(async () => {}),
    handleUrlClick: vi.fn(),
    syncNow: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('SyncSettingsSection status precedence', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
  });

  function render(status: string, backgroundError: boolean, reconnecting: boolean): string {
    app = mount(SyncSettingsSection, {
      target,
      props: {
        sync: makeSync(status),
        backgroundError,
        backgroundErrorMessage: 'HTTP 500',
        reconnecting,
      },
    });
    return target.textContent ?? '';
  }

  it('shows the quiet reconnecting line when no stronger status is active', () => {
    expect(render('', false, true)).toContain('Reconnecting…');
  });

  it('gives an escalated error priority over reconnecting', () => {
    const text = render('', true, true);
    expect(text).toContain('HTTP 500');
    expect(text).not.toContain('Reconnecting…');
  });

  it('gives transient operation progress priority over failure state', () => {
    const text = render('Uploading 1/2…', true, true);
    expect(text).toContain('Uploading 1/2…');
    expect(text).not.toContain('HTTP 500');
    expect(text).not.toContain('Reconnecting…');
  });
});

describe("SyncSettingsSection's verbs: each one while its control is drawn", () => {
  let app: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    if (app) unmount(app);
    app = null;
  });

  function offered(overrides: Partial<SyncSettings>): { sync: SyncSettings; names: string[] } {
    const sync = makeSync('', overrides);
    app = mount(SyncSettingsSection, {
      target: document.body.appendChild(document.createElement('div')),
      props: { sync, backgroundError: false, backgroundErrorMessage: '', reconnecting: false },
    });
    flushSync();
    return { sync, names: registeredVerbs().map((verb) => verb.name) };
  }

  it('offers only Connect while disconnected', () => {
    expect(offered({ connected: false }).names).toEqual(['ConnectSync']);
  });

  it('offers Forget password only while one is saved', () => {
    expect(offered({ passwordSaved: true }).names).toEqual([
      'SyncNow',
      'ForgetSyncPassword',
      'ResetSyncConnection',
    ]);
  });

  it('types the restart password before Sync now while none is saved', async () => {
    const { sync, names } = offered({ passwordSaved: false });
    expect(names).toEqual(['SyncNow', 'ResetSyncConnection']);
    let passwordAtSync = '';
    vi.mocked(sync.syncNow).mockImplementation(async () => void (passwordAtSync = sync.password));
    await registeredVerbs()[0].run({ password: 'vault pw' });
    expect(passwordAtSync).toBe('vault pw');
  });
});
