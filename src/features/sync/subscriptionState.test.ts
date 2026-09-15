// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { resolveLocalizedMessage } from '$shared/localization';

import { subscriptionStateMessage } from './subscriptionState';
import type { BillingStatusOutput } from './syncContract.generated';

function billing(overrides: Partial<BillingStatusOutput> = {}): BillingStatusOutput {
  return {
    entitled: true,
    state: 'active',
    graceUntil: null,
    storageQuotaBytes: 10_000_000_000,
    blobMaxBytes: 104_857_600,
    bytesUsed: 0,
    ...overrides,
  };
}

describe('subscriptionStateMessage', () => {
  it('says the subscription state in words, not the provider vocabulary', () => {
    const cases: Array<[string, string]> = [
      ['active', 'Active'],
      ['trialing', 'Trial'],
      ['canceled', 'Expired'],
      ['paused', 'Paused'],
      ['none', 'No subscription'],
    ];
    for (const [state, expected] of cases) {
      expect(resolveLocalizedMessage(subscriptionStateMessage(billing({ state })))).toBe(expected);
    }
  });

  it('tells a past-due account when sync stops, because that is what it can act on', () => {
    const graceUntil = new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000).toISOString();
    const text = resolveLocalizedMessage(
      subscriptionStateMessage(billing({ state: 'past_due', entitled: true, graceUntil })),
    );
    expect(text).toContain('Payment failed');
    expect(text).toContain('7 days');
  });

  it('still says payment failed when the server sent no grace date', () => {
    const text = resolveLocalizedMessage(
      subscriptionStateMessage(billing({ state: 'past_due', graceUntil: null })),
    );
    expect(text).toBe('Payment failed. Sync will pause.');
  });

  it('ignores an unparseable grace date rather than printing a broken one', () => {
    const text = resolveLocalizedMessage(
      subscriptionStateMessage(billing({ state: 'unpaid', graceUntil: 'not a date' })),
    );
    expect(text).toBe('Payment failed. Sync will pause.');
  });

  it('falls back to the entitlement for a state it has never seen', () => {
    expect(
      resolveLocalizedMessage(
        subscriptionStateMessage(billing({ state: 'quantum', entitled: true })),
      ),
    ).toBe('Active');
    expect(
      resolveLocalizedMessage(
        subscriptionStateMessage(billing({ state: 'quantum', entitled: false })),
      ),
    ).toBe('No subscription');
  });
});
