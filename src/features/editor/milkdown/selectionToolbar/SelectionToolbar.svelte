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

  import { localizedText } from '$shared/localization';
  import type { Component } from 'svelte';
  import { TOOLBAR_GROUPS, TOOLBAR_ITEMS } from '@futo-notes/editor';

  import LinkUrlField from '../linkPrompt/LinkUrlField.svelte';

  interface Props {
    onexec: (command: string) => void;
    /** Apply `href` to the selection; `null` removes the link. */
    onlink: (href: string | null) => void;
    /** The URL field opened or closed. */
    onlinkediting: (editing: boolean) => void;
  }

  let { onexec, onlink, onlinkediting }: Props = $props();

  // Found by content, not `TOOLBAR_GROUPS[1]` — the manifest's Undo/Redo group
  // (QA-003) shifted every later group's index, and a position-based lookup
  // would have silently started rendering the wrong group here. `code-block`
  // (QA-009) is excluded: this bar has no icon registered for it and this
  // surface already has the `/` menu's Code block item for that conversion —
  // adding it here is a separate design decision, not implied by either QA fix.
  const BLOCK_TYPE_GROUP =
    TOOLBAR_GROUPS.find((group) => group.some((item) => item.id === 'quote')) ?? [];
  const BLOCK_BUTTONS = [
    ...BLOCK_TYPE_GROUP.filter((item) => item.id !== 'code-block'),
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
  let urlField: ReturnType<typeof LinkUrlField> | undefined = $state();

  /** Called by `index.ts` on every selection the toolbar is shown for. */
  export function setState(nextActive: string[], nextLinkHref: string | null): void {
    active = nextActive;
    linkHref = nextLinkHref;
  }

  /** Back to the buttons — the toolbar is hiding, or the field was dismissed. */
  export function reset(): void {
    if (editingLink) onlinkediting(false);
    editingLink = false;
  }

  function preventFocus(event: MouseEvent): void {
    event.preventDefault();
  }

  function openLinkField(): void {
    editingLink = true;
    onlinkediting(true);
    // After the field renders. `tick` would do too; a frame is what the
    // provider's own show/position pass uses.
    requestAnimationFrame(() => urlField?.focus());
  }

  function commitLink(href: string): void {
    editingLink = false;
    onlinkediting(false);
    onlink(href === '' ? null : href);
  }

  function cancelLinkField(): void {
    editingLink = false;
    onlinkediting(false);
    // `linkHref` with nothing typed is "leave the link as it is"; the plugin
    // only touches the document when the href actually changed.
    onlink(linkHref);
  }
</script>

<div class="futo-selection-toolbar-body" role="toolbar" aria-label="Text formatting">
  {#if editingLink}
    <LinkUrlField
      bind:this={urlField}
      initialUrl={linkHref ?? ''}
      applyLabel={linkHref === null ? 'Add' : 'Update'}
      onsubmit={commitLink}
      oncancel={cancelLinkField}
    />
  {:else}
    {#each BLOCK_BUTTONS as item (item.id)}
      {#if item.when !== 'inContainer' || active.some( (id) => ['quote', 'bullet-list', 'ordered-list', 'task-list'].includes(id) )}
        <button
          class="futo-selection-toolbar-btn"
          class:is-active={active.includes(item.id)}
          type="button"
          aria-label={localizedText(item.localizationPath)}
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
