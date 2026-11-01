import { describe, it, expect } from 'vitest';
import { assertFixtureSimulator } from './ios-capture-fixture.mjs';

describe('fixture test destination', () => {
  it('refuses physical, sibling, stale and unbooted destinations before testing', () => {
    const root = '/task/worktree';
    const selected = '00000000-0000-0000-0000-000000000001';
    const valid = { name: 'futo-qa-0', udid: selected, state: 'Booted' };
    const owned = { worktree: root, id: selected, wipePending: false };
    const options = { inspect: (name) => (name === valid.name ? valid : null), owner: () => owned };
    expect(assertFixtureSimulator(root, selected, options)).toBe(selected);
    for (const mutation of [
      { owner: () => ({ ...owned, worktree: '/other' }) },
      { owner: () => ({ ...owned, wipePending: true }) },
      { owner: () => ({ ...owned, id: 'stale' }) },
      { inspect: () => ({ ...valid, state: 'Shutdown' }) },
    ]) {
      expect(() => assertFixtureSimulator(root, selected, { ...options, ...mutation })).toThrow();
    }
    expect(() => assertFixtureSimulator(root, '00008150-PHYSICAL', options)).toThrow();
    expect(() => assertFixtureSimulator(root, '', options)).toThrow();
  });
});
