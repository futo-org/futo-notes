<script lang="ts">
  import DropdownMenu, { type DropdownMenuEntry } from '$shared/dialogs/DropdownMenu.svelte';
  import { getNoteSortOrder, setNoteSortOrder } from '$features/notes/notes.svelte';
  import {
    sortDirectionLabelPath,
    sortDirections,
    withSortDirection,
    withSortKey,
  } from '$features/notes/noteSortOrder';
  import type { NoteSortKey, NoteSortOrder, SortDirection } from '$lib/localNoteStore';
  import { localizedText } from '$shared/localization';

  let open = $state(false);

  function choose(order: NoteSortOrder): void {
    void setNoteSortOrder(order).catch((error) =>
      console.warn('[local-notes] sort order change failed:', error),
    );
  }

  function keyItem(order: NoteSortOrder, key: NoteSortKey, path: string): DropdownMenuEntry {
    return {
      label: { path },
      checked: order.key === key,
      onclick: () => choose(withSortKey(order, key)),
    };
  }

  function directionItem(order: NoteSortOrder, direction: SortDirection): DropdownMenuEntry {
    return {
      label: { path: sortDirectionLabelPath(order.key, direction) },
      checked: order.direction === direction,
      onclick: () => choose(withSortDirection(order, direction)),
    };
  }

  const entries = $derived.by((): DropdownMenuEntry[] => {
    const order = getNoteSortOrder();
    const [first, second] = sortDirections(order.key);
    return [
      { heading: { path: 'notes.sort.heading' } },
      keyItem(order, 'name', 'notes.sort.name'),
      keyItem(order, 'lastModified', 'notes.sort.lastModified'),
      { heading: { path: 'notes.sort.orderHeading' } },
      directionItem(order, first),
      directionItem(order, second),
    ];
  });
</script>

<DropdownMenu
  {open}
  ontoggle={() => {
    open = !open;
  }}
  onclose={() => {
    open = false;
  }}
  {entries}
  label={localizedText('notes.sort.heading')}
  toggleClass="sidebar-icon-btn sidebar-sort-btn"
  toggleTestId="note-sort-btn"
  closeOnSelect={false}
>
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 6h11" />
    <path d="M4 12h8" />
    <path d="M4 18h4" />
    <path d="M17.5 8v11.5" />
    <path d="m14 16 3.5 3.5 3.5-3.5" />
  </svg>
</DropdownMenu>
