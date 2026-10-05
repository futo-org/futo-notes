<script lang="ts">
  import { FolderPlus, Plus } from '@lucide/svelte';
  import { vaultAvailability } from '$features/storage/vaultAvailability.svelte';
  import { localizedText } from '$shared/localization';

  interface Props {
    onclicknewfolder: () => void;
    onclicknewnote: () => void;
  }

  let { onclicknewfolder, onclicknewnote }: Props = $props();
</script>

<div class="fab-row">
  <button
    class="fab"
    aria-label={localizedText('notes.newNote')}
    disabled={vaultAvailability.unavailable}
    onclick={onclicknewnote}
  >
    <Plus size={18} strokeWidth={2.5} />
    {localizedText('notes.newNoteShort')}
  </button>
  <button
    class="fab fab-folder"
    aria-label={localizedText('folders.newFolder')}
    data-testid="new-folder-btn"
    disabled={vaultAvailability.unavailable}
    onclick={onclicknewfolder}
  >
    <FolderPlus size={18} />
  </button>
</div>
