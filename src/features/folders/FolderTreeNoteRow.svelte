<script lang="ts">
  import { idLeaf } from '$lib/platform/pathSafety';
  import { localizedText, type LocalizedMessage } from '$shared/localization';

  import type { NoteNode } from './folderTree';
  import TreeRowRename from './TreeRowRename.svelte';

  interface Props {
    node: NoteNode;
    indentPixels: number;
    selected: boolean;
    renameRequest?: { id: string; nonce: number } | null;
    onselect: (event: MouseEvent) => void;
    oncontextmenu: (event: MouseEvent) => void;
    onrename?: (
      id: string,
      newTitle: string,
    ) => Promise<LocalizedMessage | null> | LocalizedMessage | null;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    ondragover: (event: DragEvent) => void;
    ondrop: (event: DragEvent) => void;
  }

  let {
    node,
    indentPixels,
    selected,
    renameRequest = null,
    onselect,
    oncontextmenu,
    onrename,
    ondragstart,
    ondragend,
    ondragover,
    ondrop,
  }: Props = $props();

  // Renaming a note is renaming its file, so this mirrors the folder row exactly
  // — same double-click / F2 gesture, same shared field, same commit semantics.
  let isEditing = $state(false);
  let lastRenameNonce = -1;

  $effect(() => {
    if (
      !renameRequest ||
      renameRequest.id !== node.note.id ||
      renameRequest.nonce === lastRenameNonce
    ) {
      return;
    }
    lastRenameNonce = renameRequest.nonce;
    isEditing = true;
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'F2') return;
    event.preventDefault();
    event.stopPropagation();
    isEditing = true;
  }
</script>

{#if isEditing}
  <!-- A <button> may not contain a text field, so rename mode swaps the row for
       a div of the same class — identical height and indent, so the virtualized
       row pitch is unchanged. -->
  <div
    class="note-row"
    class:selected
    style="--indent: {node.depth * indentPixels}px"
    data-note-id={node.note.id}
  >
    <TreeRowRename
      initialValue={idLeaf(node.note.title)}
      label={localizedText('notes.title.fieldAccessibilityLabel')}
      testId="note-rename-input"
      onsubmit={(value) => onrename?.(node.note.id, value) ?? null}
      onclose={() => {
        isEditing = false;
      }}
    />
  </div>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <button
    type="button"
    class="note-row"
    class:selected
    style="--indent: {node.depth * indentPixels}px"
    onclick={onselect}
    ondblclick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      isEditing = true;
    }}
    onkeydown={handleKeydown}
    onauxclick={(event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      onselect(event);
    }}
    {oncontextmenu}
    draggable={true}
    {ondragstart}
    {ondragend}
    {ondragover}
    {ondrop}
    data-note-id={node.note.id}
  >
    <span class="note-title">{idLeaf(node.note.title)}</span>
  </button>
{/if}
