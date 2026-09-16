import { beforeEach, describe, expect, it } from 'vitest';

import { currentWriteRefusal, recordWriteRefusal } from './hostedWriteRefusal.svelte';

describe('the last cycle write refusal', () => {
  beforeEach(() => recordWriteRefusal(null));

  it('starts with nothing to say', () => {
    expect(currentWriteRefusal()).toBeNull();
  });

  it('remembers what the last cycle answered', () => {
    recordWriteRefusal('subscriptionRequired');
    expect(currentWriteRefusal()).toBe('subscriptionRequired');
    recordWriteRefusal('quotaExceeded');
    expect(currentWriteRefusal()).toBe('quotaExceeded');
  });

  // The reason it is recorded on EVERY cycle rather than only on a refused
  // one: buying room has to clear the banner on its own.
  it('is cleared by the next cycle that was not refused', () => {
    recordWriteRefusal('quotaExceeded');
    recordWriteRefusal(null);
    expect(currentWriteRefusal()).toBeNull();
  });
});
