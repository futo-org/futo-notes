<script lang="ts">
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
    aria-label="Notes view"
    onclick={() => onselect('notes')}
  >
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
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  </button>
  <button
    class:active={selected === 'tags'}
    aria-label="Tags view"
    onclick={() => onselect('tags')}
  >
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
      <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" />
      <path d="M7 7h.01" />
    </svg>
  </button>
  <button
    class:active={selected === 'images'}
    aria-label="Images view"
    onclick={() => onselect('images')}
  >
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
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  </button>
</div>
