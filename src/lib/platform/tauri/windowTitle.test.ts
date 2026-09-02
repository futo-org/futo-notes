import { beforeEach, describe, expect, it, vi } from 'vitest';

const setTitle = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

import { applyApplicationWindowTitle } from './windowTitle';

describe('applyApplicationWindowTitle', () => {
  beforeEach(() => setTitle.mockReset());

  it('sets catalog-resolved text on the native window', async () => {
    await applyApplicationWindowTitle('FUTO 笔记');

    expect(setTitle).toHaveBeenCalledWith('FUTO 笔记');
  });
});
