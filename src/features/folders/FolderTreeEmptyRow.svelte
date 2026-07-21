<script lang="ts">
  import type { EmptyFolderPlaceholderNode } from './folderTree';

  interface Props {
    node: EmptyFolderPlaceholderNode;
    indentPixels: number;
    ondragover: (event: DragEvent) => void;
    ondrop: (event: DragEvent) => void;
  }

  let { node, indentPixels, ondragover, ondrop }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="folder-empty-row"
  style="--row-indent: {node.depth * indentPixels}px"
  {ondragover}
  {ondrop}
  data-folder-path={node.parentPath}
  data-testid="folder-empty-state"
>
  Nothing here yet
</div>
