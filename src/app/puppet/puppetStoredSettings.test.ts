// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { storedSettings } from './puppetStoredSettings';

afterEach(() => localStorage.clear());

describe('storedSettings', () => {
  it('is every stored key as stored, secrets as whether they are set', () => {
    localStorage.setItem('futo-notes:openFolders', '["work"]');
    localStorage.setItem('futo_feedback_draft', 'half a thought');
    const settings = storedSettings({
      preferences: { theme: 'dark' },
      lastSyncedAt: 5,
      e2eeAuthToken: 'secret-token',
      e2eeSalt: '',
    });
    expect(settings).toEqual({
      appState: {
        preferences: { theme: 'dark' },
        lastSyncedAt: 5,
        e2eeAuthToken: 'set',
        e2eeSalt: null,
      },
      localStorage: { 'futo-notes:openFolders': ['work'], futo_feedback_draft: 'half a thought' },
    });
  });
});
