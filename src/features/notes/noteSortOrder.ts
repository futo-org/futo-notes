import {
  DEFAULT_NOTE_SORT_ORDER,
  type NoteSortKey,
  type NoteSortOrder,
  type SortDirection,
} from '$lib/localNoteStore';

export const NOTE_SORT_ORDER_KEY = 'futo-notes:noteSortOrder';

const KEYS: readonly NoteSortKey[] = ['lastModified', 'name'];
const DIRECTIONS: readonly SortDirection[] = ['ascending', 'descending'];

export function readPersistedNoteSortOrder(): NoteSortOrder {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTE_SORT_ORDER_KEY) ?? 'null');
    return isNoteSortOrder(parsed)
      ? { key: parsed.key, direction: parsed.direction }
      : DEFAULT_NOTE_SORT_ORDER;
  } catch {
    return DEFAULT_NOTE_SORT_ORDER;
  }
}

function isNoteSortOrder(value: unknown): value is NoteSortOrder {
  return (
    typeof value === 'object' &&
    value !== null &&
    KEYS.includes((value as NoteSortOrder).key) &&
    DIRECTIONS.includes((value as NoteSortOrder).direction)
  );
}

export function persistNoteSortOrder(order: NoteSortOrder): void {
  try {
    localStorage.setItem(NOTE_SORT_ORDER_KEY, JSON.stringify(order));
  } catch {
    return;
  }
}

export function sortDirections(key: NoteSortKey): [SortDirection, SortDirection] {
  return key === 'name' ? ['ascending', 'descending'] : ['descending', 'ascending'];
}

export function withSortKey(order: NoteSortOrder, key: NoteSortKey): NoteSortOrder {
  return {
    key,
    direction: sortDirections(key)[Math.max(sortDirections(order.key).indexOf(order.direction), 0)],
  };
}

export function withSortDirection(order: NoteSortOrder, direction: SortDirection): NoteSortOrder {
  return { key: order.key, direction };
}

export function sortDirectionLabelPath(key: NoteSortKey, direction: SortDirection): string {
  if (key === 'name') {
    return direction === 'ascending' ? 'notes.sort.aToZ' : 'notes.sort.zToA';
  }
  return direction === 'descending' ? 'notes.sort.newest' : 'notes.sort.oldest';
}
