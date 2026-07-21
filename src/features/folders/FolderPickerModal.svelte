<script lang="ts">
  import { buildFolderTree, type TreeNode, type FolderNode } from './folderTree';
  import { getEmptyFolders } from './emptyFolders.svelte';
  import { portal } from '$shared/dom/portal';
  import type { NotePreview } from '$shared/types/note';

  interface Props {
    title?: string;
    notes: NotePreview[];
    excludePaths?: ReadonlyArray<string>;
    onpick: (path: string) => void;
    oncancel: () => void;
  }

  let { title = 'Move to folder', notes, excludePaths = [], onpick, oncancel }: Props = $props();

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

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div use:portal class="modal-backdrop" onclick={oncancel}>
  <div class="modal-card" onclick={(e) => e.stopPropagation()}>
    <h2 class="modal-title">{title}</h2>
    <div class="picker-list">
      <button
        type="button"
        class="picker-row root"
        onclick={() => onpick('')}
        data-testid="folder-picker-root"
      >
        <span class="root-icon" aria-hidden="true">
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
              d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
            /><polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        Notes
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
            <svg
              width="14"
              height="14"
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
          </span>
          {folder.name}
        </button>
      {/each}
    </div>
    <div class="modal-actions">
      <button type="button" class="modal-btn" onclick={oncancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal-card {
    background: var(--color-bg, #fff);
    color: var(--color-text, #000);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
    padding: 16px;
    width: 360px;
    max-width: calc(100% - 32px);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
  }
  .modal-title {
    font-weight: 600;
    margin: 0 0 12px;
    font-size: 1.05rem;
  }
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
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .modal-btn {
    border-radius: 6px;
    padding: 6px 14px;
    border: 1px solid var(--color-border, #d1d5db);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
</style>
