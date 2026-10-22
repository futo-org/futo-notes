<script lang="ts">
  import { FileText, Image, Tag } from '@lucide/svelte';
  import { localizedText } from '$shared/localization';

  import { puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';

  export type SidebarView = 'notes' | 'tags' | 'images';

  interface Props {
    selected: SidebarView;
    onselect: (view: SidebarView) => void;
  }

  let { selected, onselect }: Props = $props();

  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb(
        'SetSidebarView',
        { view: 'notes|tags|images' },
        (args) => onselect(args.view as SidebarView),
        {
          controls: [
            'sidebar.views.notesAccessibilityLabel',
            'sidebar.views.tagsAccessibilityLabel',
            'sidebar.views.imagesAccessibilityLabel',
          ],
        },
      ),
    ]),
  );
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
