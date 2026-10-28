import { expect, it, vi } from 'vitest';

const writeClipboardText = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('$lib/platform/tauri', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHostedVault: async () => 'ABCD-EFGH',
}));
vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPlatformFS: async () => ({ writeClipboardText }),
}));

import { puppetCopied } from '$app/puppet/puppetRegistry';

import { createHostedSyncSettings } from './createHostedSyncSettings.svelte';

it('Copy records the recovery key it put on the clipboard', async () => {
  const hosted = createHostedSyncSettings();
  await hosted.createVault('a vault password');
  await hosted.copyRecoveryKey();
  expect(writeClipboardText).toHaveBeenCalledWith('ABCD-EFGH');
  expect(puppetCopied()?.text).toBe('ABCD-EFGH');
});
