// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';

import SyncStatusBar from './SyncStatusBar.svelte';

describe('SyncStatusBar', () => {
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

  it('shows the quiet reconnecting indicator instead of the idle connected tick', () => {
    app = mount(SyncStatusBar, {
      target,
      props: {
        statusMessage: '',
        indicatorVisible: false,
        offline: false,
        reconnecting: true,
        connected: true,
      },
    });

    expect(target.querySelector('[aria-label="Reconnecting to sync server"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="Sync up to date"]')).toBeNull();
  });

  it('gives an escalated error priority over reconnecting', () => {
    app = mount(SyncStatusBar, {
      target,
      props: {
        statusMessage: '',
        indicatorVisible: false,
        offline: false,
        error: true,
        errorMessage: 'HTTP 500',
        reconnecting: true,
        connected: false,
      },
    });

    expect(target.querySelector('[aria-label^="Sync error: HTTP 500"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="Reconnecting to sync server"]')).toBeNull();
  });
});
