import { describe, expect, it } from 'vitest';
import { devicesForRelease, parseReleaseArgs } from './qa-release.mjs';

const devices = [
  { platform: 'ios', name: 'futo-qa-0' },
  { platform: 'android', name: 'futo-qa-1' },
];

describe('QA release selection', () => {
  it('preserves all-platform cleanup when no platform is supplied', () => {
    expect(parseReleaseArgs([])).toEqual({ platform: undefined, shutdown: false });
    expect(devicesForRelease(devices, undefined)).toEqual(devices);
  });

  it('releases only the selected platform and keeps shutdown orthogonal', () => {
    expect(parseReleaseArgs(['ios', '--shutdown'])).toEqual({ platform: 'ios', shutdown: true });
    expect(devicesForRelease(devices, 'ios')).toEqual([devices[0]]);
  });

  it('rejects ambiguous or unknown platform selectors', () => {
    expect(() => parseReleaseArgs(['ios', 'android'])).toThrow(/at most one platform/);
    expect(() => parseReleaseArgs(['all'])).toThrow(/unknown release platform/);
    expect(() => parseReleaseArgs(['--shutdonw'])).toThrow(/unknown release option/);
  });
});
