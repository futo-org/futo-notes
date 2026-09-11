<script lang="ts">
  /*
   * The Link URL field — one input, one Add/Update button — extracted so the
   * `/` menu's Link item (`../slash/exec.ts`, QA-019) and the desktop
   * selection toolbar's Link button (`../selectionToolbar/SelectionToolbar.svelte`,
   * added in d70bf007) show and behave as the SAME prompt rather than two. The
   * markup, classes and keyboard handling are unchanged from the toolbar's
   * original inline version; only the surrounding state (which button label,
   * what a submit/cancel means) moved out to each caller, since the toolbar's
   * "Update an existing link" and the slash menu's "insert a brand new one"
   * mean different things on submit.
   */
  import { untrack } from 'svelte';

  interface Props {
    initialUrl: string;
    /** Add when there is no link yet to edit, Update when there is one. */
    applyLabel: 'Add' | 'Update';
    onsubmit: (url: string) => void;
    /** Escape, or however the caller decides "nothing typed, leave it". */
    oncancel: () => void;
  }

  let { initialUrl, applyLabel, onsubmit, oncancel }: Props = $props();

  // Seeded once: the field owns the text from the moment it opens.
  let draft = $state(untrack(() => initialUrl));
  let input: HTMLInputElement | undefined = $state();

  /** Focuses the field — callers position/mount first, then call this. */
  export function focus(): void {
    input?.focus();
  }

  function commit(): void {
    onsubmit(draft.trim());
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      oncancel();
    }
  }

  function preventFocus(event: MouseEvent): void {
    event.preventDefault();
  }
</script>

<input
  class="futo-selection-toolbar-url"
  type="url"
  placeholder="Paste or type a link"
  aria-label="Link URL"
  bind:this={input}
  bind:value={draft}
  onkeydown={handleKeydown}
/>
<button
  class="futo-selection-toolbar-apply"
  type="button"
  aria-label={applyLabel === 'Add' ? 'Add link' : 'Update link'}
  onmousedown={preventFocus}
  onclick={commit}>{applyLabel}</button
>
