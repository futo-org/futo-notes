<script lang="ts">
  /*
   * The desktop selection toolbar's DOM: five inline-format buttons and, behind
   * the Link one, a URL field. Positioning is NOT here — `index.ts` hands this
   * element to Milkdown's `TooltipProvider`, the same floating-ui placement the
   * `/` menu and the ⠿ handle use. This only renders buttons and reports taps.
   *
   * The button set is the CodeMirror editor's (Bold / Italic / Strikethrough /
   * Code / Link — docs/plan/desktop-editor-parity.md D1). Four of the five are
   * manifest commands run through the shared `toolbarExec`; Link is the one
   * with a UI of its own, because a link needs a URL and the desktop has no
   * other place to type one (docs/spec/editor.md "Markdown toolbar" Gap).
   *
   * Mousedown is prevented on every control so the editor keeps focus and its
   * selection — the same rule EmbedToolbar.svelte and the `/` menu follow. The
   * URL field is the exception: it takes focus on purpose, and `index.ts` keeps
   * the toolbar shown while it has it.
   */
  import { Bold, Code, Italic, Link, Strikethrough } from '@lucide/svelte';
  import type { Component } from 'svelte';

  import type { SelectionToolbarCommand } from './target';

  interface Props {
    onexec: (command: SelectionToolbarCommand) => void;
    /** Apply `href` to the selection; `null` removes the link. */
    onlink: (href: string | null) => void;
    /** The URL field opened or closed. */
    onlinkediting: (editing: boolean) => void;
  }

  let { onexec, onlink, onlinkediting }: Props = $props();

  const BUTTONS: { id: SelectionToolbarCommand; label: string; icon: Component }[] = [
    { id: 'bold', label: 'Bold', icon: Bold },
    { id: 'italic', label: 'Italic', icon: Italic },
    { id: 'strikethrough', label: 'Strikethrough', icon: Strikethrough },
    { id: 'code', label: 'Code', icon: Code },
  ];

  /** Manifest ids active at the selection, plus `code` (formatState.ts + inline code). */
  let active = $state<string[]>([]);
  /** The href of the link the selection sits in, or null. */
  let linkHref = $state<string | null>(null);
  let editingLink = $state(false);
  let draft = $state('');
  let urlField: HTMLInputElement | undefined = $state();

  /** Called by `index.ts` on every selection the toolbar is shown for. */
  export function setState(nextActive: string[], nextLinkHref: string | null): void {
    active = nextActive;
    linkHref = nextLinkHref;
  }

  /** Back to the buttons — the toolbar is hiding, or the field was dismissed. */
  export function reset(): void {
    if (editingLink) onlinkediting(false);
    editingLink = false;
    draft = '';
  }

  function preventFocus(event: MouseEvent): void {
    event.preventDefault();
  }

  function openLinkField(): void {
    draft = linkHref ?? '';
    editingLink = true;
    onlinkediting(true);
    // After the field renders. `tick` would do too; a frame is what the
    // provider's own show/position pass uses.
    requestAnimationFrame(() => urlField?.focus());
  }

  function commitLink(): void {
    const href = draft.trim();
    editingLink = false;
    onlinkediting(false);
    onlink(href === '' ? null : href);
  }

  function handleFieldKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editingLink = false;
      onlinkediting(false);
      // `null` with nothing typed is "leave the link as it is"; the plugin only
      // touches the document when the href actually changed.
      onlink(linkHref);
    }
  }
</script>

<div class="futo-selection-toolbar-body" role="toolbar" aria-label="Text formatting">
  {#if editingLink}
    <input
      class="futo-selection-toolbar-url"
      type="url"
      placeholder="Paste or type a link"
      aria-label="Link URL"
      bind:this={urlField}
      bind:value={draft}
      onkeydown={handleFieldKeydown}
    />
    <button
      class="futo-selection-toolbar-apply"
      type="button"
      aria-label={linkHref === null ? 'Add link' : 'Update link'}
      onmousedown={preventFocus}
      onclick={commitLink}>{linkHref === null ? 'Add' : 'Update'}</button
    >
  {:else}
    {#each BUTTONS as button (button.id)}
      {@const Icon = button.icon}
      <button
        class="futo-selection-toolbar-btn"
        class:is-active={active.includes(button.id)}
        type="button"
        aria-label={button.label}
        aria-pressed={active.includes(button.id)}
        onmousedown={preventFocus}
        onclick={() => onexec(button.id)}><Icon size={16} strokeWidth={2.25} /></button
      >
    {/each}
    <span class="futo-selection-toolbar-separator"></span>
    <button
      class="futo-selection-toolbar-btn"
      class:is-active={linkHref !== null}
      type="button"
      aria-label={linkHref === null ? 'Link' : 'Edit link'}
      aria-pressed={linkHref !== null}
      onmousedown={preventFocus}
      onclick={openLinkField}><Link size={16} strokeWidth={2.25} /></button
    >
  {/if}
</div>
