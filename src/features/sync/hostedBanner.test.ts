import { describe, expect, it } from 'vitest';

import { hostedBanner } from './hostedBanner';
import type { BillingStatusOutput } from '$lib/platform/tauri/hostedSync';

function billing(overrides: Partial<BillingStatusOutput> = {}): BillingStatusOutput {
  return {
    entitled: true,
    state: 'active',
    graceUntil: null,
    storageQuotaBytes: 1_000,
    blobMaxBytes: 100,
    bytesUsed: 10,
    ...overrides,
  };
}

describe('hostedBanner', () => {
  it('says nothing while the account may write and has room', () => {
    expect(hostedBanner(billing(), true)).toBe('none');
  });

  it('pauses sync when the account may not write', () => {
    expect(hostedBanner(billing({ entitled: false }), true)).toBe('syncPaused');
  });

  it('reports a full vault once used storage reaches the quota', () => {
    expect(hostedBanner(billing({ bytesUsed: 1_000 }), true)).toBe('vaultFull');
    expect(hostedBanner(billing({ bytesUsed: 1_001 }), true)).toBe('vaultFull');
  });

  // Telling someone to buy more storage would be the wrong instruction: a
  // lapsed subscription refuses the write whatever the quota says.
  it('prefers sync paused over a full vault when both are true', () => {
    expect(hostedBanner(billing({ entitled: false, bytesUsed: 5_000 }), true)).toBe('syncPaused');
  });

  // A quota of zero is "not known yet", which is how the stand-in server
  // expresses a filled vault on an account that has stored nothing.
  it('treats a zero quota as unknown rather than full', () => {
    expect(hostedBanner(billing({ storageQuotaBytes: 0, bytesUsed: 0 }), true)).toBe('none');
  });

  it('says nothing before the wizard has finished, or with no reading at all', () => {
    expect(hostedBanner(billing({ entitled: false }), false)).toBe('none');
    expect(hostedBanner(null, true)).toBe('none');
  });

  // The second input: what the last cycle's own 402/507 said, decided in Rust
  // (`futo_notes_sync::WriteRefusal`). It is what makes the banner appear the
  // moment the refused cycle ends instead of on the next billing read.
  describe('the last cycle refusal', () => {
    it('raises the banner with no billing reading at all', () => {
      expect(hostedBanner(null, true, 'subscriptionRequired')).toBe('syncPaused');
      expect(hostedBanner(null, true, 'quotaExceeded')).toBe('vaultFull');
    });

    it('raises the banner while the last billing reading still looks healthy', () => {
      expect(hostedBanner(billing(), true, 'subscriptionRequired')).toBe('syncPaused');
      expect(hostedBanner(billing(), true, 'quotaExceeded')).toBe('vaultFull');
    });

    // The same precedence, reached from either input or from one of each.
    it('prefers sync paused over a full vault', () => {
      expect(hostedBanner(billing({ bytesUsed: 5_000 }), true, 'subscriptionRequired')).toBe(
        'syncPaused',
      );
      expect(hostedBanner(billing({ entitled: false }), true, 'quotaExceeded')).toBe('syncPaused');
    });

    it('is not a latch: a cycle that was not refused leaves the reading in charge', () => {
      expect(hostedBanner(billing(), true, null)).toBe('none');
      expect(hostedBanner(billing({ entitled: false }), true, null)).toBe('syncPaused');
    });

    // A refusal from the account that just signed out must not greet whoever
    // signs in next.
    it('says nothing before the wizard has finished', () => {
      expect(hostedBanner(null, false, 'subscriptionRequired')).toBe('none');
      expect(hostedBanner(null, false, 'quotaExceeded')).toBe('none');
    });
  });
});
