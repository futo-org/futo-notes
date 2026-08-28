import { describe, expect, it } from 'vitest';

import { gauntletArtifactCapture } from './artifactCapture';

describe('gauntletArtifactCapture', () => {
  it('keeps normal Playwright failure evidence by default', () => {
    expect(gauntletArtifactCapture({})).toBe('retain-on-failure');
  });

  it('accepts only the explicit exhaustive-run mode', () => {
    expect(
      gauntletArtifactCapture({ EDITOR_GAUNTLET_ARTIFACT_CAPTURE: 'off-retry-on-failure' }),
    ).toBe('off-retry-on-failure');
    expect(() => gauntletArtifactCapture({ EDITOR_GAUNTLET_ARTIFACT_CAPTURE: 'off' })).toThrow(
      /must be off-retry-on-failure/,
    );
  });
});
