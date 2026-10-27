// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { crashlogBaseUrl, setUsingStagingCrashlog, usingStagingCrashlog } from './crashlogEndpoint';

describe('crashlogEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubEnv('VITE_DEV_CRASHLOG_PORT', '5127');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults a dev build to the local collector', () => {
    expect(usingStagingCrashlog()).toBe(false);
    expect(crashlogBaseUrl()).toBe('http://localhost:5127');
  });

  it('sends to staging once the toggle is on', () => {
    setUsingStagingCrashlog(true);

    expect(usingStagingCrashlog()).toBe(true);
    expect(crashlogBaseUrl()).toBe('https://staging-notes-crashlog.futo.org');
  });

  it('goes back to local when the toggle is turned off', () => {
    setUsingStagingCrashlog(true);
    setUsingStagingCrashlog(false);

    expect(crashlogBaseUrl()).toBe('http://localhost:5127');
  });

  it('uses each build worktree collector without cross-routing', () => {
    vi.stubEnv('VITE_DEV_CRASHLOG_PORT', '5113');
    expect(crashlogBaseUrl()).toBe('http://localhost:5113');
    vi.stubEnv('VITE_DEV_CRASHLOG_PORT', '5141');
    expect(crashlogBaseUrl()).toBe('http://localhost:5141');
  });

  it('refuses missing or malformed developer collector ports', () => {
    for (const port of ['', 'NaN', '0', '65536', '5127.5']) {
      vi.stubEnv('VITE_DEV_CRASHLOG_PORT', port);
      expect(() => crashlogBaseUrl()).toThrow('collector port');
    }
  });

  it('a release build always resolves to production, whatever the toggle says', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_DEV_CRASHLOG_PORT', 'invalid');
    setUsingStagingCrashlog(true);
    window.localStorage.setItem('futo_crashlog_staging', 'true');

    expect(usingStagingCrashlog()).toBe(false);
    expect(crashlogBaseUrl()).toBe('https://notes-crashlog.futo.org');
  });
});
