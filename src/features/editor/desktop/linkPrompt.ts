/* The Link prompt (decision 2026-11-17: the Milkdown editor's URL field, reused as it is): a
 * small URL field over the selection, from the selection toolbar's Link button and Mod+K.
 * Inside a link (the engine's `inspect_link`) it opens prefilled and Update sets that link's
 * destination, an empty field removing the link; over a selection Add links it; at a plain caret
 * Add inserts the URL as its own label, the caret after it (the engine's answer); an empty
 * field over a selection removes the links it touches. Escape or a
 * press outside cancels, and the note stays as it was. The prompt belongs to the note and the
 * revision it opened on: another note, or any edit since, makes its submit do nothing, and
 * opening another note closes it. Each edit is the engine's `set_link`, one Undo step, of the
 * destination the engine saves for what was typed (`normalize_link_destination`). */
import type { DisplayRange, LinkDescription } from '@futo-notes/editor/wasm-payloads';
import { flushSync, mount, unmount } from 'svelte';
import LinkUrlField from '../milkdown/linkPrompt/LinkUrlField.svelte';
import type { Engine } from './engine';
import type { EditorView } from './view';

/** Between the selection and the prompt, and the prompt and the window's edges, px. */
const GAP = 8;

/** What the prompt was opened on: the note's engine at one revision, and the range it edits. */
interface LinkClaim {
  engine: Engine;
  revision: number;
  range: DisplayRange;
  link: LinkDescription | null;
}

export class EditorLinkPrompt {
  private close: (() => void) | null = null;
  /** The last selection's link, read for the toolbar on every frame it draws. */
  private inspected: {
    engine: Engine;
    revision: number;
    range: DisplayRange;
    lit: boolean;
  } | null = null;

  constructor(private readonly view: EditorView) {}

  /** Whether the selection lies in one link: the toolbar's Link button is lit. */
  lit(): boolean {
    const engine = this.view.currentEngine();
    if (!engine) return false;
    const range = this.view.selection.bytes();
    const known = this.inspected;
    if (
      known?.engine === engine &&
      known.revision === engine.revision &&
      known.range.start === range.start &&
      known.range.end === range.end
    ) {
      return known.lit;
    }
    const lit = engine.inspectLink(range) !== null;
    this.inspected = { engine, revision: engine.revision, range, lit };
    return lit;
  }

  /** Open the prompt on the selection; nothing where the engine says a link would change
   *  nothing there (`allowed` leaves Link out). */
  open(): void {
    const view = this.view;
    const shown = view.selection.sync();
    const engine = view.currentEngine();
    if (!shown || !engine || !view.dom.isContentEditable) return;
    if (!view.formatting.allows('Link')) return;
    this.dismiss();
    const range = view.selection.bytes();
    const claim: LinkClaim = {
      engine,
      revision: engine.revision,
      range,
      link: engine.inspectLink(range),
    };
    const prompt = document.createElement('div');
    prompt.className = 'desktop-link-prompt';
    const field = mount(LinkUrlField, {
      target: prompt,
      props: {
        initialUrl: claim.link?.destination ?? '',
        applyLabel: claim.link ? 'Update' : 'Add',
        onsubmit: (url: string) => {
          finish();
          this.submit(claim, url);
        },
        oncancel: () => {
          finish();
          view.focus();
        },
      },
    });
    const outside = (event: PointerEvent) => {
      if (!prompt.contains(event.target as Node)) finish();
    };
    const finish = () => {
      if (this.close !== finish) return;
      this.close = null;
      document.removeEventListener('pointerdown', outside, true);
      void unmount(field);
      prompt.remove();
    };
    this.close = finish;
    document.body.append(prompt);
    this.place(prompt, shown.start);
    document.addEventListener('pointerdown', outside, true);
    // A mounted component binds its elements in effects, which have not run yet.
    flushSync();
    field.focus();
  }

  /** Close the prompt, changing nothing (another note opened). */
  dismiss(): void {
    this.close?.();
  }

  /** Below the selection's start, inside the window. */
  private place(prompt: HTMLElement, start: number): void {
    const view = this.view;
    const line = view.lineElements()[view.lineAt(start)].getBoundingClientRect();
    const at = view.caretSide.clientRect(start) ?? new DOMRect(line.left, line.top, 0, line.height);
    const width = prompt.offsetWidth;
    const height = prompt.offsetHeight;
    const below = at.bottom + GAP;
    const top = below + height <= window.innerHeight ? below : Math.max(GAP, at.top - GAP - height);
    const left = Math.max(GAP, Math.min(at.left, window.innerWidth - GAP - width));
    prompt.style.left = `${left}px`;
    prompt.style.top = `${top}px`;
  }

  private submit(claim: LinkClaim, url: string): void {
    const view = this.view;
    view.focus();
    const { engine, revision, range, link } = claim;
    if (view.currentEngine() !== engine || engine.revision !== revision) return;
    // An empty field at a plain caret adds nothing; over a selection it unlinks what it touches.
    if (!link && url === '' && range.start === range.end) return;
    const noteId = view.noteId();
    if (noteId === null) return;
    view.run((current) =>
      current.setLink(link?.range ?? range, current.normalizeLinkDestination(noteId, url)),
    );
  }
}
