// The puppet verbs for the note tree's rows, which FolderTreeView.svelte registers once for the
// whole tree. `view` is the component's state and props, read at each call.
import type { NotePreview } from '$shared/types/note';
import {
  puppetRefusal,
  puppetVerb,
  SHORTCUT_STEPS,
  type PuppetVerb,
} from '$app/puppet/puppetRegistry';
import { scrollLanded } from '$app/puppet/puppetScroll';
import { toggleFolderOpen } from './folderExpansion.svelte';
import { flattenFolderTree, type FlatNode, type TreeNode } from './folderTree';

export interface FolderTreePuppetView {
  readonly tree: TreeNode[];
  readonly items: NotePreview[];
  readonly flat: FlatNode[];
  readonly scroller: HTMLDivElement | undefined;
  readonly rowPitch: number;
  readonly FALLBACK_ROW_PITCH: number;
  keyOf(node: FlatNode): string;
  readonly onfoldercontextmenu?: (path: string, x: number, y: number) => void;
  readonly onnotecontextmenu?: (id: string, x: number, y: number) => void;
  readonly ondropnoteonfolder?: (noteId: string, folderPath: string) => Promise<void> | void;
  readonly ondropfolderonfolder?: (folderPath: string, targetPath: string) => Promise<void> | void;
  readonly ondropnoteonroot?: (noteId: string) => Promise<void> | void;
  readonly ondropfolderonroot?: (folderPath: string) => Promise<void> | void;
}

export function folderTreePuppetVerbs(view: FolderTreePuppetView): PuppetVerb[] {
  // Every folder in the vault, drawn or not: a rename or move takes the path whatever the tree
  // shows, as the note verbs take an id.
  const folderPaths = () =>
    new Set(
      flattenFolderTree(view.tree, () => true).flatMap((n) =>
        n.type === 'folder' ? [n.path] : [],
      ),
    );
  const noteIds = () => new Set(view.items.map((note) => note.id));
  const refuseUnless = (present: boolean, what: string) =>
    present ? null : puppetRefusal(400, `no such ${what}`);

  /**
   * `ScrollToRow`: the instant way to bring a row on screen, where a person would scroll the
   * tree until they saw it. It reaches only what scrolling reaches: a row inside a collapsed
   * folder is refused, because no scroll would show it. The rows are virtualized, so the
   * tree's own index is the only place a row's offset is known.
   */
  function scrollToRow(args: Record<string, unknown>) {
    const id = args.noteId as string | undefined;
    const path = args.path as string | undefined;
    if ((id === undefined) === (path === undefined)) {
      return puppetRefusal(400, 'ScrollToRow takes "noteId" or "path", one of them');
    }
    const refusal =
      id !== undefined
        ? refuseUnless(noteIds().has(id), `note: ${id}`)
        : refuseUnless(folderPaths().has(path!), `folder: ${path}`);
    if (refusal) return refusal;
    if (!view.scroller) return puppetRefusal(409, 'the note tree is not on screen');
    const index = view.flat.findIndex(
      (node) => view.keyOf(node) === (id !== undefined ? `n:${id}` : `f:${path}`),
    );
    if (index < 0) {
      return puppetRefusal(409, `${id ?? path} has no row: a folder above it is collapsed`);
    }
    const pitch = view.rowPitch > 0 ? view.rowPitch : view.FALLBACK_ROW_PITCH;
    const top = index * pitch;
    const from = view.scroller.scrollTop;
    if (top < from) view.scroller.scrollTop = top;
    else if (top + pitch > from + view.scroller.clientHeight) {
      view.scroller.scrollTop = top + pitch - view.scroller.clientHeight;
    }
    return view.scroller.scrollTop === from ? undefined : scrollLanded(view.scroller);
  }

  return [
    puppetVerb(
      'ToggleFolder',
      { path: 'string' },
      (args) => {
        const path = args.path as string;
        const refusal = refuseUnless(folderPaths().has(path), `folder: ${path}`);
        if (refusal) return refusal;
        toggleFolderOpen(path);
        return undefined;
      },
      { controlsMatching: '.folder-row' },
    ),
    puppetVerb(
      'OpenFolderContextMenu',
      { path: 'string', x: 'integer?', y: 'integer?', item: 'string?' },
      (args) => {
        const path = args.path as string;
        const refusal = refuseUnless(folderPaths().has(path), `folder: ${path}`);
        if (refusal) return refusal;
        return view.onfoldercontextmenu?.(
          path,
          (args.x as number | undefined) ?? 0,
          (args.y as number | undefined) ?? 0,
        );
      },
      { shortcuts: { item: SHORTCUT_STEPS.item } },
    ),
    puppetVerb(
      'OpenNoteContextMenu',
      { noteId: 'string', x: 'integer?', y: 'integer?', item: 'string?' },
      (args) => {
        const id = args.noteId as string;
        const refusal = refuseUnless(noteIds().has(id), `note: ${id}`);
        if (refusal) return refusal;
        return view.onnotecontextmenu?.(
          id,
          (args.x as number | undefined) ?? 0,
          (args.y as number | undefined) ?? 0,
        );
      },
      { shortcuts: { item: SHORTCUT_STEPS.item } },
    ),
    // A row dragged onto a folder row; targetPath '' is the root, a drop on the empty tree area.
    puppetVerb('MoveNote', { noteId: 'string', targetPath: 'string' }, (args) => {
      const id = args.noteId as string;
      const targetPath = args.targetPath as string;
      const refusal =
        refuseUnless(noteIds().has(id), `note: ${id}`) ??
        refuseUnless(targetPath === '' || folderPaths().has(targetPath), `folder: ${targetPath}`);
      if (refusal) return refusal;
      return targetPath === ''
        ? view.ondropnoteonroot?.(id)
        : view.ondropnoteonfolder?.(id, targetPath);
    }),
    puppetVerb('MoveFolder', { path: 'string', targetPath: 'string' }, (args) => {
      const path = args.path as string;
      const targetPath = args.targetPath as string;
      const refusal =
        refuseUnless(folderPaths().has(path), `folder: ${path}`) ??
        refuseUnless(targetPath === '' || folderPaths().has(targetPath), `folder: ${targetPath}`);
      if (refusal) return refusal;
      return targetPath === ''
        ? view.ondropfolderonroot?.(path)
        : view.ondropfolderonfolder?.(path, targetPath);
    }),
    puppetVerb('ScrollToRow', { noteId: 'string?', path: 'string?' }, scrollToRow, {
      convenience: true,
    }),
  ];
}
