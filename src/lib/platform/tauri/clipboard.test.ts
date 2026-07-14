import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeText } = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText }));

import { writeClipboardText } from './clipboard';

describe('writeClipboardText', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue();
  });

  it('writes text through the native clipboard plugin', async () => {
    await writeClipboardText('/notes/example.md');

    expect(writeText).toHaveBeenCalledWith('/notes/example.md');
  });
});
