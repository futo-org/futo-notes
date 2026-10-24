import { expect, it, vi } from 'vitest';
import {
  eraseClaimedPoolSimulator,
  eraseSimulator,
  existingIosRecoveryClaim,
} from './ios-recovery.mjs';

it('requires one existing iOS claim instead of acquiring a different simulator for erase', () => {
  expect(() => existingIosRecoveryClaim([])).toThrow('existing');
  expect(() =>
    existingIosRecoveryClaim([
      { platform: 'ios', name: 'futo-qa-1' },
      { platform: 'ios', name: 'futo-qa-2' },
    ]),
  ).toThrow('exactly one');
  expect(
    existingIosRecoveryClaim([
      { platform: 'android', name: 'futo-qa-0' },
      { platform: 'ios', name: 'futo-qa-1' },
    ]),
  ).toBe('futo-qa-1');
});

function fixture() {
  const state = { status: 'Booted', udid: 'owned-udid', owner: '/owned', time: 0 };
  const execute = vi.fn((command, args) => {
    if (args[1] === 'shutdown') state.status = 'Shutdown';
  });
  const deps = {
    inspect: vi.fn(() => ({ name: 'futo-qa-1', udid: state.udid, state: state.status })),
    owner: vi.fn(() => ({ worktree: state.owner })),
    execute,
    wait: async (ms) => {
      state.time += ms;
    },
    now: () => state.time,
    timeoutMs: 300,
  };
  return { state, execute, deps };
}

it('shuts down and erases only the originally claimed simulator', async () => {
  const { execute, deps } = fixture();
  await eraseClaimedPoolSimulator('futo-qa-1', '/owned', deps);
  expect(execute.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
    ['xcrun', 'simctl', 'shutdown', 'owned-udid'],
    ['xcrun', 'simctl', 'erase', 'owned-udid'],
  ]);
});

it('never treats a personal device or a peer claim as erase authorization', async () => {
  const { state, execute, deps } = fixture();
  await expect(eraseClaimedPoolSimulator('My phone', '/owned', deps)).rejects.toThrow('pool');
  expect(deps.inspect).not.toHaveBeenCalled();
  state.owner = '/peer';
  await expect(eraseClaimedPoolSimulator('futo-qa-1', '/owned', deps)).rejects.toThrow('owned');
  expect(execute).not.toHaveBeenCalled();
});

it.each(['owner', 'udid'])('rechecks %s after shutdown before erasing', async (field) => {
  const { state, execute, deps } = fixture();
  execute.mockImplementation(() => {
    state.status = 'Shutdown';
    state[field] = 'replacement';
  });
  await expect(eraseClaimedPoolSimulator('futo-qa-1', '/owned', deps)).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});

it('refuses erase when shutdown never reaches its observed condition', async () => {
  const { execute, deps } = fixture();
  execute.mockImplementation(() => {});
  await expect(eraseClaimedPoolSimulator('futo-qa-1', '/owned', deps)).rejects.toThrow('Shutdown');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('propagates erase failures and requires an ownership check even for a shutdown device', async () => {
  const { state, execute, deps } = fixture();
  state.status = 'Shutdown';
  execute.mockImplementation(() => {
    throw new Error('erase refused');
  });
  await expect(eraseClaimedPoolSimulator('futo-qa-1', '/owned', deps)).rejects.toThrow(
    'erase refused',
  );
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(eraseSimulator('anything', {})).rejects.toThrow('ownership');
});
