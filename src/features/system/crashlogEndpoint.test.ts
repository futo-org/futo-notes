// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { crashlogBaseUrl, setUsingStagingCrashlog, usingStagingCrashlog } from './crashlogEndpoint';

describe('crashlogEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults a dev build to the local collector', () => {
    expect(usingStagingCrashlog()).toBe(false);
    expect(crashlogBaseUrl()).toBe('http://localhost:5100');
  });

  it('sends to staging once the toggle is on', () => {
    setUsingStagingCrashlog(true);

    expect(usingStagingCrashlog()).toBe(true);
    expect(crashlogBaseUrl()).toBe('https://staging-notes-crashlog.futo.org');
  });

  it('goes back to local when the toggle is turned off', () => {
    setUsingStagingCrashlog(true);
    setUsingStagingCrashlog(false);

    expect(crashlogBaseUrl()).toBe('http://localhost:5100');
  });

  it('a release build always resolves to production, whatever the toggle says', () => {
    vi.stubEnv('DEV', false);
    setUsingStagingCrashlog(true);
    window.localStorage.setItem('futo_crashlog_staging', 'true');

    expect(usingStagingCrashlog()).toBe(false);
    expect(crashlogBaseUrl()).toBe('https://notes-crashlog.futo.org');
  });
});
