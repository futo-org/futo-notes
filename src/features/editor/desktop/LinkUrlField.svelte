<script lang="ts">
  /*
   * The Link URL field — one input, one Add/Update button — that the Link
   * prompt (`linkPrompt.ts`) mounts over the selection, for the selection
   * toolbar's Link button, Mod+K and the `/` menu's Link item (QA-019). Only
   * the surrounding state (which button label, what a submit/cancel means)
   * belongs to the caller.
   */
  import { untrack } from 'svelte';

  import { puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';

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

  /* The field and its button as verbs while the field is up, wherever it is mounted (the
   * selection toolbar's Link button, the `/` menu's Link item, the toolbar's Link command):
   * typing the URL, Add/Update (or Enter), and Escape. */
  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb('SetLinkUrl', { url: 'string' }, (args) => void (draft = args.url as string), {
        controls: ['editor.linkPrompt.urlAccessibilityLabel'],
      }),
      puppetVerb('ApplyLink', {}, commit, {
        controls: [
          'editor.linkPrompt.addAccessibilityLabel',
          'editor.linkPrompt.updateAccessibilityLabel',
        ],
      }),
      puppetVerb('CancelLink', {}, oncancel),
    ]),
  );

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
  placeholder={localizedText('editor.linkPrompt.placeholder')}
  aria-label={localizedText('editor.linkPrompt.urlAccessibilityLabel')}
  bind:this={input}
  bind:value={draft}
  onkeydown={handleKeydown}
/>
<button
  class="futo-selection-toolbar-apply"
  type="button"
  aria-label={applyLabel === 'Add'
    ? localizedText('editor.linkPrompt.addAccessibilityLabel')
    : localizedText('editor.linkPrompt.updateAccessibilityLabel')}
  onmousedown={preventFocus}
  onclick={commit}
  >{applyLabel === 'Add'
    ? localizedText('editor.linkPrompt.add')
    : localizedText('editor.linkPrompt.update')}</button
>
