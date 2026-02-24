export type SearchMode = 'keyword' | 'vector' | 'hybrid';

let currentMode: SearchMode = 'hybrid';

export function getSearchMode(): SearchMode {
  return currentMode;
}

export function setSearchMode(mode: SearchMode): void {
  currentMode = mode;
}
