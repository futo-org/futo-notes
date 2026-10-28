// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { registeredVerbs } from '$app/puppet/puppetRegistry';

import DangerSettingsSection from './DangerSettingsSection.svelte';

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  vi.useRealTimers();
});

it('TestCrash throws outside the verb, where the crash handler sees it as it sees the click', async () => {
  vi.useFakeTimers();
  app = mount(DangerSettingsSection, {
    target: document.body.appendChild(document.createElement('div')),
    props: { resetting: false, onreset: async () => {} },
  });
  flushSync();
  const testCrash = registeredVerbs().find((verb) => verb.name === 'TestCrash')!;
  await testCrash.run({});
  expect(() => vi.runAllTimers()).toThrow('Test crash from Settings');
});
