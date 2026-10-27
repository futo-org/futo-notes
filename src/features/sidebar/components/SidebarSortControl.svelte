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
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';

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

  // The sort button, and while its menu is open one pick from it, as a click on its row makes:
  // a key keeps the list's position (newest first stays first), a direction applies to the
  // key in use.
  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb('ToggleSortMenu', {}, () => void (open = !open)),
      ...(open
        ? [
            puppetVerb(
              'SetSortOrder',
              { key: 'name|lastModified?', direction: 'ascending|descending?' },
              (args) => {
                if ((args.key === undefined) === (args.direction === undefined)) {
                  return puppetRefusal(400, 'one pick at a time: {"key":…} or {"direction":…}');
                }
                const order = getNoteSortOrder();
                return setNoteSortOrder(
                  args.key !== undefined
                    ? withSortKey(order, args.key as NoteSortKey)
                    : withSortDirection(order, args.direction as SortDirection),
                );
              },
            ),
          ]
        : []),
    ]),
  );

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
