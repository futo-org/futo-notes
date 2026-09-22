<script lang="ts">
  import { FileText, Folder } from '@lucide/svelte';
  import { buildFolderTree, type TreeNode, type FolderNode } from './folderTree';
  import { getEmptyFolders } from './emptyFolders.svelte';
  import Modal from '$shared/dialogs/Modal.svelte';
  import type { NotePreview } from '$shared/types/note';
  import { localizedText } from '$shared/localization';

  interface Props {
    title?: string;
    notes: NotePreview[];
    excludePaths?: ReadonlyArray<string>;
    onpick: (path: string) => void;
    oncancel: () => void;
  }

  let { title, notes, excludePaths = [], onpick, oncancel }: Props = $props();

  const resolvedTitle = $derived(title ?? localizedText('folders.movePickerHeading'));

  const excludeSet = $derived(new Set(excludePaths));

  function flattenAll(nodes: TreeNode[]): FolderNode[] {
    const out: FolderNode[] = [];
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.type === 'folder') {
          if (excludeSet.has(n.path)) continue;
          let blocked = false;
          for (const ex of excludeSet) {
            if (n.path === ex || n.path.startsWith(`${ex}/`)) {
              blocked = true;
              break;
            }
          }
          if (blocked) continue;
          out.push(n);
          walk(n.children);
        }
      }
    };
    walk(nodes);
    return out;
  }

  const folders = $derived(flattenAll(buildFolderTree(notes, getEmptyFolders())));
</script>

<Modal title={resolvedTitle} cardClass="modal-card-scroll" ondismiss={oncancel}>
  <div class="picker-list">
    <button
      type="button"
      class="picker-row root"
      onclick={() => onpick('')}
      data-testid="folder-picker-root"
    >
      <span class="root-icon" aria-hidden="true">
        <FileText size={16} />
      </span>
      {localizedText('folders.notesDestination')}
    </button>
    {#each folders as folder (folder.path)}
      <button
        type="button"
        class="picker-row"
        style="padding-left: {12 + (folder.depth + 1) * 16}px"
        onclick={() => onpick(folder.path)}
        data-folder-path={folder.path}
      >
        <span class="folder-icon" aria-hidden="true">
          <Folder size={14} />
        </span>
        {folder.name}
      </button>
    {/each}
  </div>
  <div class="modal-actions">
    <button type="button" class="modal-btn modal-btn-secondary" onclick={oncancel}
      >{localizedText('common.actions.cancel')}</button
    >
  </div>
</Modal>

<style>
  .picker-list {
    flex: 1 1 auto;
    overflow-y: auto;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 6px;
    padding: 4px 0;
    min-height: 120px;
  }
  .picker-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    padding: 8px 12px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font-size: 0.95rem;
  }
  .picker-row:hover {
    background: var(--color-surface, rgba(0, 0, 0, 0.05));
  }
  .picker-row.root {
    font-weight: 600;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
  }
</style>
