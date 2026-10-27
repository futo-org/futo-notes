import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  claim: vi.fn(),
  ensure: vi.fn(),
  run: vi.fn(),
  emus: vi.fn(),
}));
vi.mock('./android-target.mjs', () => ({
  assertAndroidTarget: mocks.target,
  assertAndroidClaim: mocks.claim,
}));
vi.mock('./android-emulators.mjs', () => ({ ensureAvd: mocks.ensure, runningEmus: mocks.emus }));
vi.mock('./pool.mjs', () => ({
  EMULATOR: '/sdk/emulator/emulator',
  LEGACY_ANDROID_AVDS: ['futo-api28', 'futo-api29', 'futo-api30'],
  tryRun: mocks.run,
  sleep: vi.fn(),
}));

describe('owned Android virtual-scene camera poster', () => {
  let scratch;
  let poster;
  let macro;
  let stopped;
  let execFile;
  beforeEach(async () => {
    vi.resetAllMocks();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-camera-'));
    poster = path.join(scratch, 'QR image.png');
    macro = path.join(scratch, 'Walk_to_image_room');
    const { default: sharp } = await import('sharp');
    await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } })
      .png()
      .toFile(poster);
    fs.writeFileSync(macro, 'fixture macro');
    stopped = false;
    mocks.target.mockReturnValue('emulator-9000');
    mocks.emus.mockReturnValue({ 'futo-qa-3': 'emulator-9000' });
    mocks.ensure.mockResolvedValue('emulator-9002');
    mocks.run.mockImplementation((_command, args) => {
      if (args.includes('kill')) stopped = true;
      return 'OK';
    });
    execFile = vi.fn((_command, args) =>
      args.includes('pid=,command=')
        ? '123 /sdk/emulator/qemu/linux/qemu-system-x86_64 -avd futo-qa-3\n'
        : stopped
          ? ''
          : '/sdk/emulator/qemu/linux/qemu-system-x86_64 -avd futo-qa-3',
    );
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it('restarts only the owned emulator with exact poster arguments and runs the room macro', async () => {
    const { showCameraPoster } = await import('./android-camera.mjs');
    expect(await showCameraPoster(poster, { macroPath: macro, execFile })).toEqual({
      name: 'futo-qa-3',
      serial: 'emulator-9002',
    });
    expect(mocks.ensure).toHaveBeenCalledWith(
      'futo-qa-3',
      expect.objectContaining({
        emulatorArgs: [
          '-no-snapshot-load',
          '-camera-back',
          'virtualscene',
          '-virtualscene-poster',
          `wall=${poster}`,
          '-virtualscene-poster',
          `table=${poster}`,
        ],
      }),
    );
    expect(mocks.run).toHaveBeenCalledWith(
      'adb',
      ['-s', 'emulator-9002', 'emu', 'automation', 'play', macro],
      expect.any(Object),
    );
  });

  it('rejects a missing poster before stopping any device', async () => {
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(
      showCameraPoster(path.join(scratch, 'missing.png'), { macroPath: macro, execFile }),
    ).rejects.toThrow(/poster/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects unclaimed or recycled ownership before stopping the emulator', async () => {
    mocks.target.mockImplementation(() => {
      throw new Error('another worktree');
    });
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: macro, execFile })).rejects.toThrow(
      'another worktree',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('preserves pool config as well as legacy fixture config', async () => {
    const { showCameraPoster } = await import('./android-camera.mjs');
    await showCameraPoster(poster, { macroPath: macro, execFile });
    expect(mocks.ensure).toHaveBeenCalledWith(
      'futo-qa-3',
      expect.objectContaining({ preserveConfig: true }),
    );
  });

  it('rejects malformed image bytes before any device action', async () => {
    fs.writeFileSync(poster, 'not an image');
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: macro, execFile })).rejects.toThrow(
      'decodable PNG',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects a missing SDK macro before stopping the emulator', async () => {
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(
      showCameraPoster(poster, { macroPath: path.join(scratch, 'missing-macro'), execFile }),
    ).rejects.toThrow('macro is missing');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous host identity before stopping the emulator', async () => {
    execFile.mockReturnValue('');
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: macro, execFile })).rejects.toThrow(
      'uniquely identify',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fails a camera movement rejected by the emulator console', async () => {
    mocks.run.mockImplementation((_command, args) => {
      if (args.includes('kill')) {
        stopped = true;
        return 'OK';
      }
      return 'KO: macro not loaded';
    });
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: macro, execFile })).rejects.toThrow(
      'macro failed',
    );
  });
  it('refuses a lost claim after shutdown before launching another host process', async () => {
    mocks.claim
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('claim was released');
      });
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: macro, execFile })).rejects.toThrow(
      'claim was released',
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('rejects a directory in place of the SDK macro before stopping a device', async () => {
    const { showCameraPoster } = await import('./android-camera.mjs');
    await expect(showCameraPoster(poster, { macroPath: scratch, execFile })).rejects.toThrow(
      'macro is missing',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
