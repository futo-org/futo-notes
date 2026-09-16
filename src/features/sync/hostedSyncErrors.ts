import type { LocalizedMessage } from '$shared/localization';

import type { HostedErrorOutput } from './syncContract.generated';

/**
 * Turns a rejected `e2ee_hosted_*` command into the sentence a person reads.
 *
 * Rust answers with a variant, not a sentence, precisely so each one can be a
 * different thing to do about it — so this is a total mapping over those
 * variants and never a stringified error. Two of them matter more than the
 * rest: `signInAgain` must read as "sign in again" and never as a broken or
 * reset vault, and `recoveryKeyTypo` must name the typo rather than claim the
 * key is wrong (parent spec user stories 18 and 22).
 */
export function hostedErrorMessage(error: unknown): LocalizedMessage {
  const variant = hostedErrorVariant(error);
  if (!variant) return { path: 'sync.hosted.errors.unexpected' };
  switch (variant.kind) {
    case 'signInAgain':
      return { path: 'sync.hosted.errors.signInAgain' };
    case 'notSignedIn':
      return { path: 'sync.hosted.errors.notSignedIn' };
    case 'notHosted':
      return { path: 'sync.hosted.errors.notHosted' };
    case 'rateLimited':
      return {
        path: 'sync.hosted.errors.rateLimited',
        arguments: { seconds: variant.retryAfterSeconds },
      };
    case 'server':
      return { path: 'sync.hosted.errors.server' };
    case 'network':
      return { path: 'sync.hosted.errors.network' };
    case 'notEntitled':
      return { path: 'sync.hosted.errors.notEntitled' };
    case 'vaultAlreadyExists':
      return { path: 'sync.hosted.errors.vaultAlreadyExists' };
    case 'noVault':
      return { path: 'sync.hosted.errors.noVault' };
    case 'vaultPasswordTooShort':
      return {
        path: 'sync.hosted.errors.vaultPasswordTooShort',
        arguments: { minimum: variant.minimum },
      };
    case 'wrongVaultPassword':
      return { path: 'sync.hosted.errors.wrongVaultPassword' };
    case 'recoveryKeyFormat':
      return { path: 'sync.hosted.errors.recoveryKeyFormat' };
    case 'recoveryKeyTypo':
      return { path: 'sync.hosted.errors.recoveryKeyTypo' };
    case 'wrongRecoveryKey':
      return { path: 'sync.hosted.errors.wrongRecoveryKey' };
    case 'noRecoveryKey':
      return { path: 'sync.hosted.errors.noRecoveryKey' };
    case 'vaultKeyChangedElsewhere':
      return { path: 'sync.hosted.errors.vaultKeyChangedElsewhere' };
    case 'secretStore':
      return { path: 'sync.hosted.errors.secretStore' };
    case 'crypto':
      return { path: 'sync.hosted.errors.crypto' };
    case 'pairingCodeInvalid':
      return { path: 'sync.hosted.errors.pairingCodeInvalid' };
    case 'pairingRefused':
      return { path: 'sync.hosted.errors.pairingRefused' };
    case 'pairingAlreadyKeyed':
      return { path: 'sync.hosted.errors.pairingAlreadyKeyed' };
    case 'pairingExpired':
      return { path: 'sync.hosted.errors.pairingExpired' };
    case 'pairingNotStarted':
      return { path: 'sync.hosted.errors.pairingNotStarted' };
    case 'vaultLocked':
      return { path: 'sync.hosted.errors.vaultLocked' };
  }
}

/**
 * The variant Tauri rejected with, or `null` for anything that is not one —
 * a thrown `Error` from the IPC layer itself, say. Rejections cross as the
 * serialized enum, so the tag is a plain `kind` field.
 */
export function hostedErrorVariant(error: unknown): HostedErrorOutput | null {
  if (typeof error !== 'object' || error === null) return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' ? (error as HostedErrorOutput) : null;
}

/** True when the only way forward is a trip to the browser. */
export function needsSignInAgain(error: unknown): boolean {
  return hostedErrorVariant(error)?.kind === 'signInAgain';
}
