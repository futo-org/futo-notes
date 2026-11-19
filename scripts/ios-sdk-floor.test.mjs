import { describe, expect, it } from 'vitest';

import { sdkFloorError } from './ios-sdk-floor.mjs';

describe('sdkFloorError', () => {
  it('accepts the SDK Apple will require next April until the year turns', () => {
    expect(sdkFloorError('26.2', new Date('2026-12-31T23:59:59Z'))).toBeNull();
  });

  it('refuses that SDK from 1 January, three months before Apple does', () => {
    expect(sdkFloorError('26.2', new Date('2027-01-01T00:00:00Z'))).toMatch(
      /iOS 26\.2 SDK.*April 2027.*iOS 27 SDK.*Xcode 27/,
    );
    expect(sdkFloorError('27.2\n', new Date('2027-01-01T00:00:00Z'))).toBeNull();
  });

  it('refuses a version it cannot read', () => {
    expect(sdkFloorError('', new Date('2026-11-18T00:00:00Z'))).toMatch(/could not read/);
  });
});
