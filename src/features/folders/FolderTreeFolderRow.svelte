<script lang="ts">
  import { idLeaf } from '$lib/platform/pathSafety';

  import type { FolderNode } from './folderTree';
  import TreeRowRename from './TreeRowRename.svelte';

  interface Props {
    node: FolderNode;
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

  // The field itself (focus, commit, cancel, failure reporting) is TreeRowRename;
  // the row only decides when it is open. Note rows use the same component.
  let isEditing = $state(false);
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
    isEditing = true;
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      isEditing = true;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onclick();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="button"
  tabindex="0"
  class="folder-row"
  class:drop-target={isDropTarget}
  style="--indent: {node.depth * indentPixels}px"
  {onclick}
  ondblclick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    isEditing = true;
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
    <TreeRowRename
      initialValue={idLeaf(node.path)}
      label="Folder name"
      testId="folder-rename-input"
      onsubmit={(value) => onrename?.(node.path, value) ?? null}
      onclose={() => {
        isEditing = false;
      }}
    />
  {:else}
    <span class="folder-name">{node.name}</span>
  {/if}
</div>
