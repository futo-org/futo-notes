<script lang="ts">
  import { Capacitor, registerPlugin } from '@capacitor/core';
  import { createNote, getAllNotes, deleteNote } from '$lib/notes';
  import { sanitizeFilename } from '$lib/utils';

  interface ImportedFile {
    name: string;
    path: string;
    content: string;
    lastModified?: number;
  }

  interface FolderImportPlugin {
    pickAndReadMarkdownFiles(): Promise<{ files: ImportedFile[] }>;
    setFileModificationTime(options: { filename: string; mtime: number }): Promise<void>;
  }

  const FolderImport = registerPlugin<FolderImportPlugin>('FolderImport');
  const isNative = Capacitor.isNativePlatform();

  interface Props {
    onclose: () => void;
    onimported: (count: number) => void;
  }

  let { onclose, onimported }: Props = $props();

  let importing = $state(false);
  let importStatus = $state('');
  let nuking = $state(false);
  let nukeConfirm = $state(false);

  async function handleObsidianImport(): Promise<void> {
    if (!isNative || importing) return;

    importing = true;
    importStatus = 'Picking folder...';

    try {
      const result = await FolderImport.pickAndReadMarkdownFiles();
      const files = result.files;

      if (!files || files.length === 0) {
        importStatus = 'No markdown files found';
        setTimeout(() => { importStatus = ''; importing = false; }, 2000);
        return;
      }

      importStatus = `Importing ${files.length} notes...`;

      // Detect duplicate names
      const nameCount = new Map<string, number>();
      for (const file of files) {
        const id = sanitizeFilename(file.name);
        nameCount.set(id, (nameCount.get(id) || 0) + 1);
      }

      let imported = 0;
      for (const file of files) {
        const baseName = sanitizeFilename(file.name);
        let id = baseName;
        // Disambiguate duplicates with folder path
        if ((nameCount.get(baseName) || 0) > 1 && file.path) {
          id = sanitizeFilename(`${file.name} (${file.path})`);
        }
        if (id) {
          const created = await createNote(id, file.content, file.lastModified);
          if (file.lastModified) {
            try {
              await FolderImport.setFileModificationTime({ filename: created.id + '.md', mtime: file.lastModified });
            } catch (_) { /* best-effort */ }
          }
          imported++;
        }
      }

      onimported(imported);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('cancelled') || msg.includes('Cancelled')) {
        importStatus = '';
        importing = false;
      } else {
        importStatus = `Error: ${msg}`;
        setTimeout(() => { importStatus = ''; importing = false; }, 3000);
      }
    }
  }

  function handleNukeTap(): void {
    if (nuking) return;
    if (!nukeConfirm) {
      nukeConfirm = true;
      return;
    }
    void doNuke();
  }

  async function doNuke(): Promise<void> {
    nuking = true;
    try {
      const allNotes = getAllNotes();
      for (const note of allNotes) {
        await deleteNote(note.id);
      }
      onimported(0);
    } catch {
      nuking = false;
      nukeConfirm = false;
    }
  }
</script>

<div class="settings-overlay" role="button" tabindex="-1" onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()}>
  <div class="settings-panel" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <div class="settings-header">
      <h2 class="settings-title">Settings</h2>
      <button class="settings-close" aria-label="Close settings" onclick={onclose}>&times;</button>
    </div>

    <div class="settings-content">
      <section class="settings-section">
        <h3 class="settings-section-title">Import</h3>
        <button class="settings-btn" onclick={handleObsidianImport} disabled={importing}>
          <span class="settings-btn-text">
            <span class="settings-btn-label">Import from Obsidian</span>
            <span class="settings-btn-desc">
              {#if importStatus}
                {importStatus}
              {:else}
                Select your vault folder to import all notes
              {/if}
            </span>
          </span>
          {#if !importing}
            <span class="settings-btn-arrow">&rsaquo;</span>
          {/if}
        </button>
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">Danger zone</h3>
        <button class="settings-btn settings-btn-danger" onclick={handleNukeTap} disabled={nuking}>
          <span class="settings-btn-text">
            <span class="settings-btn-label">
              {#if nukeConfirm}
                Tap again to confirm
              {:else}
                Delete all notes
              {/if}
            </span>
            <span class="settings-btn-desc">
              {#if nuking}
                Deleting...
              {:else if nukeConfirm}
                This cannot be undone!
              {:else}
                Permanently remove every note
              {/if}
            </span>
          </span>
        </button>
      </section>
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .settings-panel {
    width: 100%;
    max-width: 600px;
    max-height: 85vh;
    background: var(--color-bg);
    border-radius: 16px 16px 0 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 20px 12px;
    position: sticky;
    top: 0;
    background: var(--color-bg);
  }

  .settings-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0;
    color: var(--color-text);
  }

  .settings-close {
    width: 36px;
    height: 36px;
    border: none;
    background: #e8e8e8;
    border-radius: 50%;
    font-size: 22px;
    color: #666;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }

  .settings-close:active {
    background: #d8d8d8;
  }

  .settings-content {
    padding: 0 20px;
  }

  .settings-section {
    margin-bottom: 24px;
  }

  .settings-section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted);
    margin: 0 0 8px 4px;
  }

  .settings-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border: none;
    background: var(--color-surface);
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .settings-btn:active {
    opacity: 0.7;
  }

  .settings-btn:disabled {
    cursor: default;
  }

  .settings-btn:disabled:active {
    opacity: 1;
  }

  .settings-btn-danger .settings-btn-label {
    color: #d32f2f;
  }

  .settings-btn-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .settings-btn-label {
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text);
  }

  .settings-btn-desc {
    font-size: 13px;
    color: var(--color-muted);
  }

  .settings-btn-arrow {
    font-size: 22px;
    color: var(--color-muted);
    flex-shrink: 0;
    margin-left: 12px;
  }
</style>
