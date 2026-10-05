import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { tauriLocalNoteStore } from '../localNoteStore';
import { onVaultCommandFailed } from './vaultCommands';

describe('vault command failures', () => {
  const failed = vi.fn();
  beforeEach(() => {
    invoke.mockReset();
    failed.mockReset();
    onVaultCommandFailed(failed);
  });

  // A vault that still reads can refuse writes: the failed save is the only sign.
  it('reports a failed command and still rejects with its error', async () => {
    invoke.mockRejectedValue('write vault path a.md: Permission denied');
    await expect(tauriLocalNoteStore.save(null, 'a', 'body')).rejects.toBe(
      'write vault path a.md: Permission denied',
    );
    expect(failed).toHaveBeenCalledOnce();
  });

  it('stays quiet about a command that succeeds', async () => {
    invoke.mockResolvedValue('body');
    await expect(tauriLocalNoteStore.read('a')).resolves.toBe('body');
    expect(failed).not.toHaveBeenCalled();
  });
});
