/**
 * How long a pairing code has left, as a person reads it.
 *
 * The countdown is a **display** of the relay's own `expires_at` and nothing
 * more. What actually ends a wait is Rust: `await_pairing` rebuilds its poll
 * schedule from that same timestamp and answers `pairingExpired` when the
 * window closes. Two clocks deciding one fact is how a screen ends up saying
 * "0:00" next to a live code, or "4:59" next to a dead one — so this one only
 * ever describes.
 */

/** Whole seconds left before `expiresAt`, never negative. An unreadable
    timestamp reads as no time left, which is the safe way to be wrong: it
    shows the code as spent rather than promising time it may not have. */
export function secondsUntil(expiresAt: string, now: number = Date.now()): number {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return 0;
  return Math.max(0, Math.ceil((expiry - now) / 1000));
}

/** `m:ss`, the shape a countdown is read in. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
