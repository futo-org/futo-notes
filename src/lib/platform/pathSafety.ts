import { MAX_FOLDER_DEPTH } from '$lib/rules';

const CONTROL_CHARS =
  Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + String.fromCharCode(127);
const FORBIDDEN_COMPONENT_TEST = new RegExp(`[<>:"|?*${CONTROL_CHARS}]`);

function componentInvalid(component: string): boolean {
  if (component === '' || component === '.' || component === '..') {
    return true;
  }
  return FORBIDDEN_COMPONENT_TEST.test(component);
}

export function ensureSafeNoteId(id: string): void {
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  if (id.includes('\\')) {
    throw new Error('invalid note id');
  }
  if (id.startsWith('/') || id.endsWith('/')) {
    throw new Error('invalid note id');
  }
  const components = id.split('/');
  if (components.length - 1 > MAX_FOLDER_DEPTH) {
    throw new Error('note id exceeds maximum folder depth');
  }
  for (const c of components) {
    if (componentInvalid(c)) {
      throw new Error('invalid note id');
    }
  }
}

export function safeNotePath(base: string, id: string): string {
  ensureSafeNoteId(id);
  return `${base}/${id}.md`;
}

export function noteParentDir(base: string, id: string): string {
  ensureSafeNoteId(id);
  const slash = id.lastIndexOf('/');
  if (slash === -1) return base;
  return `${base}/${id.slice(0, slash)}`;
}

export function idParent(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '' : id.slice(0, slash);
}

export function idLeaf(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

export function safeAppdataPath(base: string, relPath: string): string {
  if (relPath.startsWith('/')) {
    throw new Error('path traversal blocked');
  }
  const components = relPath.split('/');
  for (const c of components) {
    if (c === '..' || c === '.' || c === '') {
      throw new Error('path traversal blocked');
    }
  }
  return `${base}/${relPath}`;
}

export function noteIdFromFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  if (!normalized.endsWith('.md')) {
    throw new Error('filename does not end with .md');
  }
  const id = normalized.slice(0, -3);
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  return id;
}
