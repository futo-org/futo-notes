<script lang="ts">
  import { FileText, Image, Tag } from '@lucide/svelte';
  import { localizedText } from '$shared/localization';

  export type SidebarView = 'notes' | 'tags' | 'images';

  interface Props {
    selected: SidebarView;
    onselect: (view: SidebarView) => void;
  }

  let { selected, onselect }: Props = $props();
</script>

<div class="sidebar-view-toggle">
  <button
    class:active={selected === 'notes'}
    aria-label={localizedText('sidebar.views.notesAccessibilityLabel')}
    onclick={() => onselect('notes')}
  >
    <FileText size={16} />
  </button>
  <button
    class:active={selected === 'tags'}
    aria-label={localizedText('sidebar.views.tagsAccessibilityLabel')}
    onclick={() => onselect('tags')}
  >
    <Tag size={16} />
  </button>
  <button
    class:active={selected === 'images'}
    aria-label={localizedText('sidebar.views.imagesAccessibilityLabel')}
    onclick={() => onselect('images')}
  >
    <Image size={16} />
  </button>
</div>
