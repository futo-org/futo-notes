// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

import SyncSettingsSection from './SyncSettingsSection.svelte';
import type { SyncSettings } from './createSyncSettings.svelte';

function makeSync(status = ''): SyncSettings {
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
    expect(text).toContain('Sync failed: HTTP 500');
    expect(text).not.toContain('Reconnecting…');
  });

  it('gives transient operation progress priority over failure state', () => {
    const text = render('Uploading 1/2…', true, true);
    expect(text).toContain('Uploading 1/2…');
    expect(text).not.toContain('Sync failed:');
    expect(text).not.toContain('Reconnecting…');
  });
});
