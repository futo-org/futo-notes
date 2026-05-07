/**
 * Module-level flag for an in-flight item drag (currently the mobile
 * touch drag in FolderTreeView). Read by gesture handlers that would
 * otherwise compete for the same touch — e.g. the drawer swipe in
 * `touchSwipe.svelte.ts` must stand down once a note is grabbed so a
 * sideways drag of the note doesn't also slide the sidebar shut.
 *
 * Plain mutable boolean — no $state. The readers are imperative event
 * handlers, not reactive contexts, so reactivity would be wasted.
 */
let itemDragging = false;

export function isItemDragging(): boolean {
  return itemDragging;
}

export function setItemDragging(v: boolean): void {
  itemDragging = v;
}
