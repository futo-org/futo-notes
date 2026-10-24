<script lang="ts">
  import DesktopTopBand from '../../../src/app/components/DesktopTopBand.svelte';
  import { tabsStore } from '../../../src/features/tabs/tabsStore.svelte';

  let sidebarCollapsed = $state(false);
  const notes = ['Chrome preview', 'Second preview'].map((title) => ({
    id: `${title}.md`,
    title,
    preview: '',
    modificationTime: 0,
    tags: [],
  }));
  tabsStore.openNote(notes[0].id, 'current');
  tabsStore.openNote(notes[1].id, 'background');
</script>

<main class="notes-shell desktop-layout" class:sidebar-collapsed={sidebarCollapsed}>
  <DesktopTopBand
    {notes}
    {sidebarCollapsed}
    ontoggle={() => (sidebarCollapsed = !sidebarCollapsed)}
  />
</main>
