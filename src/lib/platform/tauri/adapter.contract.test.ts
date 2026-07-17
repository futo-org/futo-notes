// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  exists: vi.fn<(path: string) => Promise<boolean>>(),
  getVersion: vi.fn<() => Promise<string>>(),
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  isAbsolute: vi.fn<(path: string) => Promise<boolean>>(),
  listen: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  writeClipboardText: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: native.convertFileSrc,
  invoke: native.invoke,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: native.getVersion }));
vi.mock('@tauri-apps/api/path', () => ({ isAbsolute: native.isAbsolute }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: native.writeClipboardText }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: native.exists,
  mkdir: native.mkdir,
  readDir: native.readDir,
  readFile: native.readFile,
  readTextFile: native.readTextFile,
  remove: native.remove,
  rename: native.rename,
  stat: native.stat,
  writeFile: native.writeFile,
  writeTextFile: native.writeTextFile,
}));

const DEFAULT_ROOT = '/home/user/Documents/futo-notes';

function installCommandDefaults(): void {
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'notes_dir_override_load') return null;
    if (command === 'notes_dir_override_save') return undefined;
    if (command === 'resolve_default_notes_root') return DEFAULT_ROOT;
    if (command === 'fs_start_watcher') return undefined;
    if (command === 'fs_save_image') return 'image-imported.png';
    throw new Error(`unexpected invoke: ${command}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  installCommandDefaults();
  native.exists.mockResolvedValue(false);
  native.getVersion.mockResolvedValue('1.2.3');
  native.isAbsolute.mockImplementation(async (path: string) => path.startsWith('/'));
  native.listen.mockResolvedValue(vi.fn());
  native.mkdir.mockResolvedValue(undefined);
  native.open.mockResolvedValue(null);
  native.readDir.mockResolvedValue([]);
  native.readFile.mockRejectedValue(new Error('not found'));
  native.readTextFile.mockRejectedValue(new Error('not found'));
  native.remove.mockResolvedValue(undefined);
  native.rename.mockResolvedValue(undefined);
  native.stat.mockResolvedValue({ size: 0, mtime: null });
  native.writeFile.mockResolvedValue(undefined);
  native.writeClipboardText.mockResolvedValue(undefined);
  native.writeTextFile.mockResolvedValue(undefined);
});

describe('Tauri adapter public contract', () => {
  it('exposes every required PlatformFS operation and native capability', async () => {
    const { tauriFS } = await import('../tauri');

    for (const operation of [
      'readAppData',
      'writeAppData',
      'deleteAppData',
      'listAppData',
      'listDirFiles',
      'deleteFile',
      'saveImage',
      'getImageUrl',
      'getAppVersion',
      'writeClipboardText',
      'saveImageBytes',
      'pickImage',
    ] as const) {
      expect(tauriFS[operation], operation).toBeTypeOf('function');
    }
  });

  it('writes text through the native clipboard plugin', async () => {
    const { tauriFS } = await import('../tauri');

    await tauriFS.writeClipboardText('/notes/example.md');

    expect(native.writeClipboardText).toHaveBeenCalledWith('/notes/example.md');
  });

  it('translates only missing app-data operations into absence sentinels', async () => {
    const { tauriFS } = await import('../tauri');

    expect(await tauriFS.readAppData('.missing.json')).toBeNull();
    native.readDir.mockRejectedValueOnce(new Error('No such file or directory'));
    expect(await tauriFS.listAppData('.missing')).toEqual([]);
    native.remove.mockRejectedValueOnce(new Error('not found'));
    await expect(tauriFS.deleteAppData('.missing.json')).resolves.toBeUndefined();

    native.exists.mockResolvedValueOnce(true);
    native.readTextFile.mockRejectedValueOnce(new Error('Operation not permitted'));
    await expect(tauriFS.readAppData('.private.json')).rejects.toThrow('Operation not permitted');
  });

  it('writes text app data atomically beneath the active root', async () => {
    const { tauriFS } = await import('../tauri');

    await tauriFS.writeAppData('.state/app.json', 'durable');

    expect(native.mkdir).toHaveBeenCalledWith(`${DEFAULT_ROOT}/.state`, { recursive: true });
    expect(native.writeTextFile).toHaveBeenCalledWith(
      expect.stringMatching(`${DEFAULT_ROOT}/.state/.sf-tmp-`),
      'durable',
    );
    expect(native.rename).toHaveBeenCalledWith(
      expect.stringMatching(`${DEFAULT_ROOT}/.state/.sf-tmp-`),
      `${DEFAULT_ROOT}/.state/app.json`,
    );
  });

  it('lists only readable root files with normalized metadata', async () => {
    const { tauriFS } = await import('../tauri');
    const modified = new Date('2026-07-15T12:00:00Z');
    native.readDir.mockResolvedValueOnce([
      { name: 'kept.png', isFile: true },
      { name: 'folder', isFile: false },
      { name: 'unreadable.png', isFile: true },
    ]);
    native.stat.mockImplementation(async (path: string) => {
      if (path.endsWith('unreadable.png')) throw new Error('broken symlink');
      return { size: 9, mtime: modified };
    });

    expect(await tauriFS.listDirFiles()).toEqual([
      { name: 'kept.png', size: 9, mtime: modified.getTime() },
    ]);
  });

  it('rejects unsafe flat image operations before plugin I/O', async () => {
    const { tauriFS } = await import('../tauri');

    await expect(tauriFS.deleteFile('../secret.png')).rejects.toThrow('invalid filename');
    await expect(tauriFS.getImageUrl('notes.txt')).rejects.toThrow('not an image filename');
    await expect(tauriFS.getImageUrl('nested/image.png')).rejects.toThrow('invalid filename');
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.mkdir).not.toHaveBeenCalled();
    expect(native.remove).not.toHaveBeenCalled();
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it('delegates native capabilities and preserves command failures', async () => {
    const { tauriFS } = await import('../tauri');
    native.open.mockResolvedValueOnce('/tmp/photo.png');

    expect(await tauriFS.saveImage('/tmp/source.png')).toBe('image-imported.png');
    expect(native.invoke).toHaveBeenCalledWith('fs_save_image', {
      sourcePath: '/tmp/source.png',
    });
    expect(await tauriFS.pickImage!()).toBe('/tmp/photo.png');
    expect(await tauriFS.getAppVersion()).toBe('1.2.3');

    native.invoke.mockRejectedValueOnce(new Error('backend denied image import'));
    await expect(tauriFS.saveImage('/tmp/denied.png')).rejects.toThrow(
      'backend denied image import',
    );
  });

  it('preserves the shipped open-tab persistence shape in .app-config.json', async () => {
    const { saveConfig } = await import('../tauri');
    native.exists.mockResolvedValueOnce(true);
    native.readTextFile.mockResolvedValueOnce(JSON.stringify({ sidebarWidth: 280 }));
    const openTabs = {
      tabs: [
        {
          id: 'tab-1',
          noteId: 'Projects/Roadmap',
          pendingFolder: 'Projects',
          state: { scroll: 125, selFrom: 3, selTo: 8 },
        },
      ],
      activeTabId: 'tab-1',
    };

    await saveConfig({ openTabs });

    const payload = JSON.parse(native.writeTextFile.mock.calls[0][1] as string);
    expect(payload).toEqual({ sidebarWidth: 280, openTabs });
  });

  it('caches the active root until changing the override invalidates it', async () => {
    let override: string | null = null;
    native.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'notes_dir_override_load') return override;
      if (command === 'resolve_default_notes_root') return DEFAULT_ROOT;
      if (command === 'notes_dir_override_save') {
        override = (args as { dir: string | null }).dir;
        return undefined;
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    const { setNotesDir, tauriFS } = await import('../tauri');

    await tauriFS.readAppData('.one.json');
    await tauriFS.readAppData('.two.json');
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'notes_dir_override_load'),
    ).toHaveLength(1);

    await setNotesDir('/custom/notes');
    await tauriFS.readAppData('.three.json');
    expect(native.exists).toHaveBeenLastCalledWith('/custom/notes/.three.json');
  });
});

describe('Tauri adapter listener lifecycle', () => {
  it('coalesces concurrent watcher starts into one Rust command', async () => {
    let finishStart!: () => void;
    native.invoke.mockImplementation(
      (command: string) =>
        new Promise((resolve, reject) => {
          if (command !== 'fs_start_watcher') {
            reject(new Error(`unexpected invoke: ${command}`));
            return;
          }
          finishStart = () => resolve(undefined);
        }),
    );
    const { onFileChange } = await import('../tauri');

    const stopFirst = onFileChange(vi.fn());
    const stopSecond = onFileChange(vi.fn());

    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishStart();
    stopFirst();
    stopSecond();
  });

  it('forwards native payloads and requests the Rust-owned watcher', async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    native.listen.mockImplementation(async (_name: string, callback: typeof deliver) => {
      deliver = callback;
      return vi.fn();
    });
    const callback = vi.fn();
    const { onFileChange } = await import('../tauri');

    const stop = onFileChange(callback);
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    deliver!({ payload: { type: 'rename', filename: 'new.md', from: 'old.md' } });

    expect(callback).toHaveBeenCalledWith({
      type: 'rename',
      filename: 'new.md',
      from: 'old.md',
    });
    expect(native.invoke).toHaveBeenCalledWith('fs_start_watcher');
    stop();
  });

  it('disposes a file-change unlistener that resolves after subscription teardown', async () => {
    let finishRegistration!: (cleanup: () => void) => void;
    const cleanup = vi.fn();
    native.listen.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRegistration = resolve;
      }),
    );
    const { onFileChange } = await import('../tauri');

    const stop = onFileChange(vi.fn());
    stop();
    stop();
    finishRegistration(cleanup);

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});
