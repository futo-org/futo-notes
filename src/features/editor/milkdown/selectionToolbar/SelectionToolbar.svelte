<script lang="ts">
  import {
    Bold,
    Code,
    Italic,
    Link,
    Strikethrough,
    TextQuote,
    ListIndentIncrease,
    ListIndentDecrease,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { TOOLBAR_GROUPS, TOOLBAR_ITEMS } from '@futo-notes/editor';

  interface Props {
    onexec: (command: string) => void;
    /** Apply `href` to the selection; `null` removes the link. */
    onlink: (href: string | null) => void;
    /** The URL field opened or closed. */
    onlinkediting: (editing: boolean) => void;
  }

  let { onexec, onlink, onlinkediting }: Props = $props();

  const BLOCK_BUTTONS = [
    ...TOOLBAR_GROUPS[1],
    ...TOOLBAR_ITEMS.filter((item) => item.when === 'inContainer'),
  ];
  const BLOCK_ICONS: Record<string, Component> = {
    TextQuote,
    ListIndentIncrease,
    ListIndentDecrease,
  };

  const BUTTONS: { id: string; label: string; icon: Component }[] = [
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
    {#each BLOCK_BUTTONS as item (item.id)}
      {#if item.when !== 'inContainer' || active.some( (id) => ['quote', 'bullet-list', 'ordered-list', 'task-list'].includes(id) )}
        <button
          class="futo-selection-toolbar-btn"
          class:is-active={active.includes(item.id)}
          type="button"
          aria-label={item.label}
          aria-pressed={active.includes(item.id)}
          onmousedown={preventFocus}
          onclick={() => onexec(item.id)}
        >
          {#if item.text}{item.text}{:else}
            {@const Icon = BLOCK_ICONS[item.lucide]}
            <Icon size={16} strokeWidth={2.25} />
          {/if}
        </button>
      {/if}
    {/each}
    <span class="futo-selection-toolbar-separator"></span>
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
