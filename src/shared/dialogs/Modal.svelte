<script lang="ts">
  /**
   * The app's modal dialog. Compose every blocking dialog from this rather than
   * hand-rolling a backdrop: it is what makes Escape-to-dismiss, backdrop
   * dismissal, `role="dialog"`, focus containment, and focus restoration
   * automatic instead of something each new dialog has to remember.
   *
   * Escape handling itself lives in `dismissable.ts`, which also serves
   * overlays with bespoke chrome (crash report, context menu, search).
   */
  import type { Snippet } from 'svelte';

  import { portal } from '$shared/dom/portal';

  import { dismissable } from './dismissable';
  import './modal.css';

  interface Props {
    /** Heading rendered at the top of the card and used as the accessible name. */
    title?: string;
    /** Extra classes for the card (e.g. `modal-card-scroll`). */
    cardClass?: string;
    /** Whether clicking the backdrop dismisses. Off for dialogs that must be answered. */
    dismissOnBackdrop?: boolean;
    ondismiss: () => void;
    children: Snippet;
  }

  let { title, cardClass = '', dismissOnBackdrop = true, ondismiss, children }: Props = $props();

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 10)}`;

  let card: HTMLDivElement | undefined = $state();

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusableItems(): HTMLElement[] {
    if (!card) return [];
    return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  $effect(() => {
    const previouslyFocused = document.activeElement;
    // A dialog whose content focuses itself (the create-folder field) keeps
    // that focus; anything else gets the card, so Escape and Tab have a home.
    if (card && !card.contains(document.activeElement)) card.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = focusableItems();
    if (items.length === 0) {
      event.preventDefault();
      card?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<!-- The backdrop is a click surface with no keyboard role of its own: Escape
     (dismissable) is the keyboard equivalent, and every control inside the card
     is reachable by Tab. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  use:portal
  use:dismissable={{ ondismiss }}
  class="modal-backdrop"
  onclick={() => dismissOnBackdrop && ondismiss()}
>
  <div
    bind:this={card}
    class="modal-card {cardClass}"
    role="dialog"
    aria-modal="true"
    aria-labelledby={title ? titleId : undefined}
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onkeydown={handleKeydown}
  >
    {#if title}
      <h2 class="modal-title" id={titleId}>{title}</h2>
    {/if}
    {@render children()}
  </div>
</div>
