<script lang="ts">
  import type { PairingState } from '../createHostedSyncSettings.svelte';
  import { formatCountdown, secondsUntil } from '$features/sync/pairingCountdown';
  import { qrCodeDrawing } from '$features/sync/qrCode';
  import { localizedText } from '$shared/localization';

  interface Props {
    /** What the pairing is doing. Owned by the caller, because Rust's answer
        is what moves it — this component never decides a state. Named
        `pairing` rather than `state` so it cannot be read as the `$state`
        rune. */
    pairing: PairingState;
    /** The payload to draw, straight from Rust. */
    payload: string | null;
    /** RFC 3339, the relay's own deadline. */
    expiresAt: string | null;
    busy: boolean;
    onshow: () => void;
    oncancel: () => void;
  }

  let { pairing, payload, expiresAt, busy, onshow, oncancel }: Props = $props();

  const drawing = $derived(payload ? qrCodeDrawing(payload) : null);

  // The countdown is a clock on screen, not a deadline: `await_pairing` is
  // rebuilt from this same `expires_at` and is the only thing that ends the
  // wait. Reaching 0:00 here therefore means "Rust is about to say expired",
  // never "this shell decided it had".
  //
  // The reading is derived from the clock rather than assigned by the timer,
  // so the code shows its real remaining time on the frame it appears instead
  // of flashing 0:00 until the first tick.
  let now = $state(Date.now());
  const remaining = $derived(expiresAt ? secondsUntil(expiresAt, now) : 0);
  $effect(() => {
    if (pairing !== 'waiting' || !expiresAt) return;
    const tick = window.setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
</script>

{#if pairing === 'waiting' && drawing}
  <p class="hosted-title">{localizedText('sync.hosted.pairing.title')}</p>
  <p class="hosted-body">{localizedText('sync.hosted.pairing.body')}</p>

  <!-- Fixed black on white in both themes, deliberately: a camera reads dark
       modules on a light field, so theming this would break the one thing it
       is for. -->
  <div class="hosted-pairing-code">
    <svg
      viewBox="0 0 {drawing.size} {drawing.size}"
      width="220"
      height="220"
      shape-rendering="crispEdges"
      role="img"
      aria-label={localizedText('sync.hosted.pairing.codeAccessibilityLabel')}
    >
      <rect width={drawing.size} height={drawing.size} fill="#ffffff" />
      <path d={drawing.path} fill="#000000" />
    </svg>
  </div>

  <p
    class="settings-btn-desc settings-hint"
    role="status"
    aria-label={localizedText('sync.hosted.pairing.expiresInAccessibilityLabel', {
      remaining: formatCountdown(remaining),
    })}
  >
    {localizedText('sync.hosted.pairing.expiresIn', { remaining: formatCountdown(remaining) })}
  </p>
  <button class="settings-link-btn" onclick={oncancel}>
    {localizedText('sync.hosted.cancel')}
  </button>
{:else if pairing === 'received'}
  <p class="hosted-title">{localizedText('sync.hosted.pairing.received.title')}</p>
  <p class="hosted-body" role="status">
    {localizedText('sync.hosted.pairing.received.body')}
  </p>
{:else if pairing === 'expired' || pairing === 'refused'}
  <p class="hosted-title">{localizedText(`sync.hosted.pairing.${pairing}.title`)}</p>
  <p class="hosted-body" role="alert">
    {localizedText(`sync.hosted.pairing.${pairing}.body`)}
  </p>
  <div class="settings-actions">
    <button class="settings-btn settings-btn-inline" onclick={onshow} disabled={busy}>
      {localizedText('sync.hosted.pairing.showNewCode')}
    </button>
  </div>
{:else}
  <p class="hosted-body">{localizedText('sync.hosted.pairing.body')}</p>
  <div class="settings-actions">
    <button class="settings-btn settings-btn-inline" onclick={onshow} disabled={busy}>
      {localizedText('sync.hosted.pairing.showCode')}
    </button>
  </div>
{/if}
