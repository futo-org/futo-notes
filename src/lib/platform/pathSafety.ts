/**
 * Path safety utilities — TypeScript port of `ensure_safe_note_id`,
 * `safe_note_path`, `safe_appdata_path`, and `note_id_from_filename`
 * from `crates/futo-notes-core/src/files.rs`.
 *
 * Per-component character set mirrors the editor filename rule minus `/`
 * (path separator) and `\` (always
 * rejected): `< > : " | ? *` plus control chars 0x00-0x1F and 0x7F.
 *
 * Note IDs may contain forward slashes as folder separators following
 * the move to path-as-ID. Each component is validated as a filename.
 */
import { MAX_FOLDER_DEPTH } from '$lib/rules';

const CONTROL_CHARS =
  Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + String.fromCharCode(127);
// Per-component forbidden pattern: same as the filename rule minus `/` and `\` since
// `/` is a legal separator handled at the splitter and `\` is rejected at
// the top level.
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
