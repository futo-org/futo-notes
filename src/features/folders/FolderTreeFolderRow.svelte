<script lang="ts">
  import { Folder, FolderOpen } from '@lucide/svelte';
  import { idLeaf } from '$lib/platform/pathSafety';
  import { localizedText, type LocalizedMessage } from '$shared/localization';

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
    onrename?: (
      path: string,
      newName: string,
    ) => Promise<LocalizedMessage | null> | LocalizedMessage | null;
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
      <FolderOpen size={16} />
    {:else}
      <Folder size={16} />
    {/if}
  </span>
  {#if isEditing}
    <TreeRowRename
      initialValue={idLeaf(node.path)}
      label={localizedText('folders.nameField')}
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
