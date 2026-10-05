import { beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createAxeClient, launchUntilRunning } from './axeClient.mjs';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('a tap sends one real touch sequence to the explicitly selected simulator', () => {
  createAxeClient({ udid: 'claimed-sim' }).tapPoint(12.4, 29.6);
  expect(execFileSync).toHaveBeenCalledWith(
    expect.any(String),
    ['touch', '-x', '12', '-y', '30', '--down', '--up', '--delay', '0.05', '--udid', 'claimed-sim'],
    expect.any(Object),
  );
});
it('waits for a process handle after a transient simulator teardown error', () => {
  const launch = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('FBSOpenApplicationServiceErrorDomain, code=3');
    })
    .mockReturnValue('com.futo.notes.dev: 42');
  expect(launchUntilRunning(launch)).toBe('com.futo.notes.dev: 42');
  expect(launch).toHaveBeenCalledTimes(2);
});
it('preserves a permanent launch failure rather than retrying it', () => {
  const launch = vi.fn(() => {
    throw new Error('application is not installed');
  });
  expect(() => launchUntilRunning(launch)).toThrow('application is not installed');
  expect(launch).toHaveBeenCalledTimes(1);
});
it('a simulator that never returns a process handle fails within the bound', () => {
  let time = 0;
  const launch = vi.fn(() => {
    time += 1000;
    throw new Error('NSPOSIXErrorDomain, code=3');
  });
  expect(() => launchUntilRunning(launch, () => time)).toThrow('NSPOSIXErrorDomain');
  expect(launch).toHaveBeenCalledTimes(5);
});
it('software keyboard input touches the visible key instead of sending HID text', () => {
  execFileSync.mockReturnValue(
    JSON.stringify([
      {
        AXUniqueId: 'UIKeyboardLayoutStar Preview',
        children: [
          {
            AXLabel: 'z',
            frame: { x: 10, y: 700, width: 40, height: 54 },
          },
        ],
      },
    ]),
  );
  createAxeClient({ udid: 'claimed-sim', textInput: 'softwareKeyboard' }).typeText('z');
  expect(execFileSync).toHaveBeenLastCalledWith(
    expect.any(String),
    [
      'touch',
      '-x',
      '30',
      '-y',
      '727',
      '--down',
      '--up',
      '--delay',
      '0.05',
      '--udid',
      'claimed-sim',
    ],
    expect.any(Object),
  );
  expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'type')).toBe(false);
});
it('software keyboard input fails if no visible keyboard can receive it', () => {
  execFileSync.mockReturnValue('[]');
  expect(() =>
    createAxeClient({ udid: 'claimed-sim', textInput: 'softwareKeyboard' }).typeText('z'),
  ).toThrow('keyboard');
});
it.each([
  ['7', 'numbers'],
  ['Z', 'shift'],
])('selects the keyboard layout before typing %s', (character, control) => {
  let switched = false;
  execFileSync.mockImplementation((_, args) => {
    if (args[0] === 'touch') {
      switched = true;
      return '';
    }
    return JSON.stringify([
      {
        AXUniqueId: 'UIKeyboardLayoutStar Preview',
        children: [
          {
            AXLabel: switched ? character : control,
            frame: { x: 0, y: 700, width: 40, height: 54 },
          },
        ],
      },
    ]);
  });
  createAxeClient({ udid: 'claimed-sim', textInput: 'softwareKeyboard' }).typeText(character);
  expect(execFileSync.mock.calls.filter(([, args]) => args[0] === 'touch')).toHaveLength(2);
});
