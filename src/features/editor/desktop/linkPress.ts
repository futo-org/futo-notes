/* A press on a link's own glyphs (its label, a web address, a wikilink's element, wrapped rows
 * included) opens it on release: a plain click, Mod+click and a middle click (the shell picks
 * the tab: tabsStore `modeFromEvent`). It moves no caret and starts no selection. A press that
 * moves first is an ordinary press from where it began (pointer.ts), and Shift, Option, a
 * double click and Ctrl+click on Apple are never an opening. Blank space past a link is not
 * its glyphs. */
import type { EditorLinkGesture } from '../editorLinkGesture';
import { LINK_CLASS } from './lineLinks';
import { MOVE_SLOP } from './pointer';
import type { EditorView } from './view';
import { WIKILINK_CLASS } from './wikilinkElements';

/** What a press opened: a wikilink (the note it resolves to, else its target as written) or a
 *  link's destination as written. */
export type PressedLink =
  | { kind: 'wikilink'; noteId: string | null; target: string }
  | { kind: 'link'; destination: string };

export interface LinkOpening {
  link: PressedLink;
  gesture: EditorLinkGesture;
}

/** The link whose glyphs `target` (an element a press was on) draws, if any. */
export function linkUnder(view: EditorView, target: EventTarget | null): PressedLink | null {
  const element =
    target instanceof Element ? target.closest(`.${LINK_CLASS}, .${WIKILINK_CLASS}`) : null;
  const model = view.lineModel();
  if (!element || !model || !view.dom.contains(element)) return null;
  const offset = view.offsetOf(element, 0);
  const line = model.lines[model.lineAt(offset)];
  const at = offset - line.start;
  if (element.classList.contains(WIKILINK_CLASS)) {
    const atom = line.atoms.find((one) => one.kind === 'Wikilink' && one.start === at);
    if (atom?.kind !== 'Wikilink') return null;
    return { kind: 'wikilink', noteId: atom.noteId, target: atom.target };
  }
  const link = line.links.find((one) => one.start <= at && at < one.end);
  return link ? { kind: 'link', destination: link.destination } : null;
}

export class LinkPress {
  private pressed: { event: MouseEvent; opening: LinkOpening } | null = null;
  private readonly move = (event: MouseEvent) => this.moved(event);
  private readonly up = (event: MouseEvent) => this.released(event);

  constructor(
    private readonly view: EditorView,
    private readonly open: (opening: LinkOpening) => void,
  ) {}

  /** Take a press on a link's glyphs: true when it is one this handles. */
  press(event: MouseEvent): boolean {
    const apple = navigator.platform.startsWith('Mac');
    const primary =
      event.button === 0 &&
      event.detail <= 1 &&
      !event.shiftKey &&
      !event.altKey &&
      !(apple && event.ctrlKey);
    if (!primary && event.button !== 1) return false;
    const link = linkUnder(this.view, event.target);
    if (!link) return false;
    // A middle press would paste the primary selection on Linux.
    event.preventDefault();
    this.stop();
    const { altKey, ctrlKey, metaKey, shiftKey } = event;
    const button = event.button === 1 ? 1 : 0;
    this.pressed = {
      event,
      opening: { link, gesture: { button, altKey, ctrlKey, metaKey, shiftKey } },
    };
    document.addEventListener('mousemove', this.move);
    document.addEventListener('mouseup', this.up);
    return true;
  }

  destroy(): void {
    this.stop();
  }

  /** Moved past the slop: a primary press selects from where it began, as any press. */
  private moved(event: MouseEvent): void {
    const pressed = this.pressed;
    if (!pressed) return;
    const { clientX, clientY } = pressed.event;
    if (Math.hypot(event.clientX - clientX, event.clientY - clientY) < MOVE_SLOP) return;
    this.stop();
    if (pressed.event.button !== 0) return;
    this.view.pointer.down(pressed.event, false);
    this.view.pointer.drag(event);
  }

  private released(event: MouseEvent): void {
    const pressed = this.pressed;
    this.stop();
    if (pressed && event.button === pressed.event.button) this.open(pressed.opening);
  }

  private stop(): void {
    this.pressed = null;
    document.removeEventListener('mousemove', this.move);
    document.removeEventListener('mouseup', this.up);
  }
}
