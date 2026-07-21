<script lang="ts">
  import { idLeaf } from '$lib/platform/pathSafety';

  import type { NoteNode } from './folderTree';

  interface Props {
    node: NoteNode;
    indentPixels: number;
    selected: boolean;
    onselect: (event: MouseEvent) => void;
    oncontextmenu: (event: MouseEvent) => void;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    ondragover: (event: DragEvent) => void;
    ondrop: (event: DragEvent) => void;
  }

  let {
    node,
    indentPixels,
    selected,
    onselect,
    oncontextmenu,
    ondragstart,
    ondragend,
    ondragover,
    ondrop,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<button
  type="button"
  class="note-row"
  class:selected
  style="--row-indent: {node.depth * indentPixels}px"
  onclick={onselect}
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
