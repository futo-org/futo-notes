// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { resolveLocalizedMessage } from '$shared/localization';

import { hostedErrorMessage, hostedErrorVariant, needsSignInAgain } from './hostedSyncErrors';
import type { HostedErrorOutput } from './syncContract.generated';

/** Every variant the Rust contract can reject with. */
const EVERY_VARIANT: HostedErrorOutput[] = [
  { kind: 'signInAgain' },
  { kind: 'notSignedIn' },
  { kind: 'notHosted', reason: 'no such route' },
  { kind: 'rateLimited', retryAfterSeconds: 30 },
  { kind: 'server', reason: 'HTTP 500' },
  { kind: 'network', reason: 'connection refused' },
  { kind: 'notEntitled' },
  { kind: 'vaultAlreadyExists' },
  { kind: 'noVault' },
  { kind: 'vaultPasswordTooShort', minimum: 12 },
  { kind: 'wrongVaultPassword' },
  { kind: 'recoveryKeyFormat' },
  { kind: 'recoveryKeyTypo' },
  { kind: 'wrongRecoveryKey' },
  { kind: 'noRecoveryKey' },
  { kind: 'secretStore', reason: 'no secret service' },
  { kind: 'crypto', reason: 'unsupported kdf' },
  { kind: 'pairingCodeInvalid' },
  { kind: 'pairingRefused' },
  { kind: 'pairingAlreadyKeyed' },
  { kind: 'pairingExpired' },
  { kind: 'pairingNotStarted' },
  { kind: 'vaultLocked' },
];

describe('hostedErrorMessage', () => {
  it('gives every variant a real catalog sentence', () => {
    for (const variant of EVERY_VARIANT) {
      const text = resolveLocalizedMessage(hostedErrorMessage(variant));
      // A missing catalog entry resolves to the path itself.
      expect(text, variant.kind).not.toMatch(/^sync\./);
      expect(text.length, variant.kind).toBeGreaterThan(0);
    }
  });

  it('tells an expired pairing code apart from one somebody else answered', () => {
    const expired = resolveLocalizedMessage(hostedErrorMessage({ kind: 'pairingExpired' }));
    const answered = resolveLocalizedMessage(hostedErrorMessage({ kind: 'pairingAlreadyKeyed' }));
    const notOurs = resolveLocalizedMessage(hostedErrorMessage({ kind: 'pairingRefused' }));
    expect(new Set([expired, answered, notOurs]).size).toBe(3);
  });

  it('reports an expired session as sign in again, never as a lost vault', () => {
    const text = resolveLocalizedMessage(hostedErrorMessage({ kind: 'signInAgain' }));
    expect(text).toContain('Log in with FUTO again');
    expect(text).toMatch(/untouched/);
    expect(needsSignInAgain({ kind: 'signInAgain' })).toBe(true);
    expect(needsSignInAgain({ kind: 'wrongVaultPassword' })).toBe(false);
  });

  it('names a mistyped recovery key as a typo, not as the wrong key', () => {
    const typo = resolveLocalizedMessage(hostedErrorMessage({ kind: 'recoveryKeyTypo' }));
    const wrong = resolveLocalizedMessage(hostedErrorMessage({ kind: 'wrongRecoveryKey' }));
    expect(typo).toContain('typo');
    expect(typo).not.toBe(wrong);
  });

  it('carries the numbers a person acts on into the sentence', () => {
    expect(
      resolveLocalizedMessage(hostedErrorMessage({ kind: 'rateLimited', retryAfterSeconds: 45 })),
    ).toContain('45');
    expect(
      resolveLocalizedMessage(hostedErrorMessage({ kind: 'vaultPasswordTooShort', minimum: 12 })),
    ).toContain('12');
  });

  it('falls back to one sentence for anything that is not a contract variant', () => {
    expect(hostedErrorMessage(new Error('boom')).path).toBe('sync.hosted.errors.unexpected');
    expect(hostedErrorMessage('boom').path).toBe('sync.hosted.errors.unexpected');
    expect(hostedErrorMessage(null).path).toBe('sync.hosted.errors.unexpected');
    expect(hostedErrorVariant({ message: 'boom' })).toBeNull();
  });
});
