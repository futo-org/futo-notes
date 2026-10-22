// @vitest-environment jsdom
//
// The license plate's controls as the agent's verbs: each offered exactly while its
// control is on the plate, and each running what its click runs.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';

import { registeredVerbs } from '$app/puppet/puppetRegistry';

import LicenseSettingsSection from './LicenseSettingsSection.svelte';
import { license } from './license.svelte';

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const offered = (): string[] => (flushSync(), registeredVerbs().map((verb) => verb.name));
const run = (name: string, args: Record<string, unknown> = {}) =>
  registeredVerbs()
    .find((verb) => verb.name === name)!
    .run(args);

it('offers the unlicensed plate, then the key field, and activates through the field', async () => {
  const enterKey = vi.spyOn(license, 'enterKey').mockResolvedValue(true);
  const openBuyPage = vi.spyOn(license, 'openBuyPage').mockImplementation(() => {});
  app = mount(LicenseSettingsSection, {
    target: document.body.appendChild(document.createElement('div')),
  });

  expect(offered()).toEqual(['BuyLicense', 'StartLicenseEntry', 'OpenLostKeyHelp']);
  await run('BuyLicense');
  expect(openBuyPage).toHaveBeenCalled();

  await run('StartLicenseEntry');
  expect(offered()).toEqual(['ActivateLicense', 'CancelLicenseEntry']);

  await run('ActivateLicense', { licenseKey: 'FUTO-KEY' });
  expect(enterKey).toHaveBeenCalledWith('FUTO-KEY');
  // Accepted, so the field closes as it does after a click.
  expect(offered()).toEqual(['BuyLicense', 'StartLicenseEntry', 'OpenLostKeyHelp']);
});
