import { localizedRelativeTime, type LocalizedMessage } from '$shared/localization';

import type { BillingStatusOutput } from './syncContract.generated';

/**
 * The subscription, in words.
 *
 * `state` is the payment provider's own vocabulary, carried through Rust
 * verbatim, so this is where it becomes a sentence a person reads (ADR 0003,
 * decision 8). An unrecognised state falls back to the entitlement — the one
 * field that is always meaningful — rather than showing the raw word.
 *
 * A past-due account says when sync stops, because the grace period is the
 * only part of this a person can still act on.
 */
export function subscriptionStateMessage(billing: BillingStatusOutput): LocalizedMessage {
  switch (billing.state) {
    case 'active':
      return { path: 'sync.hosted.account.state.active' };
    case 'trialing':
      return { path: 'sync.hosted.account.state.trialing' };
    case 'past_due':
    case 'unpaid':
      return pastDue(billing.graceUntil);
    case 'canceled':
      return { path: 'sync.hosted.account.state.expired' };
    case 'paused':
      return { path: 'sync.hosted.account.state.paused' };
    case 'incomplete':
    case 'incomplete_expired':
      return { path: 'sync.hosted.account.state.incomplete' };
    case 'none':
      return { path: 'sync.hosted.account.state.none' };
    default:
      return billing.entitled
        ? { path: 'sync.hosted.account.state.active' }
        : { path: 'sync.hosted.account.state.none' };
  }
}

function pastDue(graceUntil: string | null): LocalizedMessage {
  const when = graceUntil ? Date.parse(graceUntil) : Number.NaN;
  if (Number.isNaN(when)) return { path: 'sync.hosted.account.state.pastDueNoDate' };
  return {
    path: 'sync.hosted.account.state.pastDue',
    arguments: { when: localizedRelativeTime(when) },
  };
}
