import { isTauri } from '$lib/platform';

const OPEN_FOLDERS_KEY = 'futo-notes:openFolders';

let openFolders = $state<Set<string>>(loadOpenFolders());
let dragHoverExpanded = $state<Set<string>>(new Set());

function loadOpenFolders(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((path): path is string => typeof path === 'string'));
    }
  } catch {
    // Open-state persistence is best-effort; malformed local data must not block rendering.
  }
  return new Set();
}

function persistOpenFolders(): void {
  const paths = [...openFolders];
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify(paths));
    } catch {
      // Quota and privacy-mode failures are non-fatal.
    }
  }
  if (!isTauri) return;

  void import('$lib/platform/tauri')
    .then(({ saveConfig }) =>
      saveConfig({ openFolders: paths }).catch((error) => {
        console.warn('Failed to persist open folders:', error);
      }),
    )
    .catch(() => {
      // Dynamic import can fail when this module is evaluated outside Tauri.
    });
}

async function hydrateOpenFolders(): Promise<void> {
  if (!isTauri) return;
  try {
    const { loadOpenFoldersConfig } = await import('$lib/platform/tauri');
    const stored = await loadOpenFoldersConfig();
    if (stored === null) {
      if (openFolders.size > 0) persistOpenFolders();
      return;
    }
    openFolders = new Set(stored);
    try {
      localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify(stored));
    } catch {
      // Quota and privacy-mode failures are non-fatal.
    }
  } catch {
    // Config hydration is best-effort; local state remains the fallback.
  }
}

if (typeof window !== 'undefined') void hydrateOpenFolders();

function ancestorFolders(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function rebasePaths(paths: Set<string>, fromPath: string, toPath: string): Set<string> {
  return new Set(
    [...paths].map((path) => {
      if (path === fromPath) return toPath;
      if (path.startsWith(`${fromPath}/`)) return `${toPath}/${path.slice(fromPath.length + 1)}`;
      return path;
    }),
  );
}

export function isFolderOpen(path: string): boolean {
  return openFolders.has(path) || dragHoverExpanded.has(path);
}

export function toggleFolderOpen(path: string): void {
  setFolderOpen(path, !openFolders.has(path));
}

export function setFolderOpen(path: string, isOpen: boolean): void {
  if (openFolders.has(path) === isOpen) return;
  const next = new Set(openFolders);
  if (isOpen) next.add(path);
  else next.delete(path);
  openFolders = next;
  persistOpenFolders();
}

export function openFolderAndAncestors(path: string): void {
  if (!path) return;
  const next = new Set(openFolders);
  const previousSize = next.size;
  ancestorFolders(path).forEach((folder) => next.add(folder));
  if (next.size === previousSize) return;
  openFolders = next;
  persistOpenFolders();
}

export function rebaseOpenFolders(fromPath: string, toPath: string): void {
  openFolders = rebasePaths(openFolders, fromPath, toPath);
  openFolderAndAncestors(toPath);
  persistOpenFolders();
}

export function removeOpenFolderTree(path: string): void {
  const next = new Set(
    [...openFolders].filter((item) => item !== path && !item.startsWith(`${path}/`)),
  );
  if (next.size === openFolders.size) return;
  openFolders = next;
  persistOpenFolders();
}

export function setDragHoverExpanded(path: string, expanded: boolean): void {
  if (dragHoverExpanded.has(path) === expanded) return;
  const next = new Set(dragHoverExpanded);
  if (expanded) next.add(path);
  else next.delete(path);
  dragHoverExpanded = next;
}

export function clearDragHoverExpanded(): void {
  if (dragHoverExpanded.size === 0) return;
  const cleared = new Set<string>();
  dragHoverExpanded = cleared;
}
