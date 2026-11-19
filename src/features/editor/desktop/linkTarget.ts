/* Where a pressed link goes (desktop/links.md): a wikilink to its note; a link or a web address
 * to the note its destination names from the open note's folder, else to the address the
 * engine opens outside the app, else nowhere. What a destination means is the engine's
 * (portable-core/links.md): the page keeps no scheme list. */
import type { EditorLinkGesture } from '../editorLinkGesture';
import type { Engine } from './engine';
import type { PressedLink } from './linkPress';

/** A note to open in the app (a wikilink's that no note holds, the shell creates), or an
 *  address for the system to open. */
export type LinkTarget = { kind: 'note'; noteId: string } | { kind: 'external'; url: string };

/** Whether the gesture that pressed a web address asks for it behind the window, as a note's
 *  background tab (tabsStore `modeFromEvent`): Mod+click or a middle click. */
export function opensBehind(gesture: EditorLinkGesture, apple: boolean): boolean {
  return gesture.button === 1 || (apple ? gesture.metaKey : gesture.ctrlKey);
}

/** Where `link`, pressed in the note `noteId` that `engine` holds, goes; null for nowhere. */
export function resolvePressedLink(
  engine: Engine,
  noteId: string,
  link: PressedLink,
): LinkTarget | null {
  if (link.kind === 'wikilink') return { kind: 'note', noteId: link.noteId ?? link.target };
  const linked = engine.resolveNoteLink(noteId, link.destination);
  if (linked !== null) return { kind: 'note', noteId: linked };
  const url = engine.externalLinkUrl(link.destination);
  return url === null ? null : { kind: 'external', url };
}
