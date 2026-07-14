<script lang="ts">
  import { tick } from 'svelte';

  import { idLeaf } from '$lib/platform/pathSafety';

  import type { FolderNode } from './folderTree';

  interface Props {
    node: FolderNode;
    index: number;
    rowHeight: number;
    indentPixels: number;
    isOpen: boolean;
    isDropTarget: boolean;
    renameRequest?: { path: string; nonce: number } | null;
    onclick: () => void;
    oncontextmenu: (event: MouseEvent) => void;
    onrename?: (path: string, newName: string) => Promise<string | null> | string | null;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    ondragover: (event: DragEvent) => void;
    ondragleave: () => void;
    ondrop: (event: DragEvent) => void;
  }

  let {
    node,
    index,
    rowHeight,
    indentPixels,
    isOpen,
    isDropTarget,
    renameRequest = null,
    onclick,
    oncontextmenu,
    onrename,
    ondragstart,
    ondragend,
    ondragover,
    ondragleave,
    ondrop,
  }: Props = $props();

  let isEditing = $state(false);
  let value = $state('');
  let error = $state<string | null>(null);
  let isSubmitting = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let lastRenameNonce = -1;

  $effect(() => {
    if (
      !renameRequest ||
      renameRequest.path !== node.path ||
      renameRequest.nonce === lastRenameNonce
    ) {
      return;
    }
    lastRenameNonce = renameRequest.nonce;
    void beginRename();
  });

  async function beginRename(): Promise<void> {
    isEditing = true;
    value = idLeaf(node.path);
    error = null;
    await tick();
    input?.focus();
    input?.select();
  }

  function cancelRename(): void {
    isEditing = false;
    value = '';
    error = null;
    isSubmitting = false;
  }

  async function submitRename(): Promise<void> {
    if (!isEditing || isSubmitting) return;
    isSubmitting = true;
    error = null;
    try {
      const renameError = await onrename?.(node.path, value);
      if (!renameError) {
        cancelRename();
        return;
      }
      error = renameError;
      await tick();
      input?.focus();
      input?.select();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Rename failed';
      await tick();
      input?.focus();
    } finally {
      isSubmitting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      void beginRename();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onclick();
    }
  }

  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void submitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="button"
  tabindex="0"
  class="folder-row virtual-row"
  class:drop-target={isDropTarget}
  style="top: {index * rowHeight}px; left: {node.depth * indentPixels}px"
  {onclick}
  ondblclick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    void beginRename();
  }}
  onkeydown={handleKeydown}
  {oncontextmenu}
  draggable={true}
  {ondragstart}
  {ondragend}
  {ondragover}
  {ondragleave}
  {ondrop}
  data-folder-path={node.path}
>
  <span class="folder-icon" aria-hidden="true">
    {#if isOpen}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"
        />
      </svg>
    {:else}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
        />
      </svg>
    {/if}
  </span>
  {#if isEditing}
    <span
      class="folder-inline-edit"
      onclick={(event) => event.stopPropagation()}
      ondblclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <input
        bind:this={input}
        bind:value
        class:error={error !== null}
        disabled={isSubmitting}
        aria-label="Folder name"
        aria-invalid={error !== null}
        title={error ?? 'Folder name'}
        onkeydown={handleRenameKeydown}
        onblur={() => !isSubmitting && void submitRename()}
        data-testid="folder-rename-input"
      />
    </span>
  {:else}
    <span class="folder-name">{node.name}</span>
  {/if}
</div>
