import {
  closeFind as closeFindIn,
  openFind as openFindIn,
  setFindOverlayInset as setFindOverlayInsetIn,
  setFindQuery as setFindQueryIn,
  stepFind as stepFindIn,
  type FindBarState,
} from './find';
import type { HostHandleDeps } from './hostHandleDeps';

/** Find in note: what a bar renders, and the calls a bar makes. */
export function createFindCommands(deps: HostHandleDeps) {
  const { pmView, props } = deps;

  /* What a find bar renders, mirrored out of the plugin by its
   * `onStateChange` and handed to whoever draws one. A projection, never the
   * source of truth: every action a bar takes comes back through the exported
   * find commands below.
   *
   * The desktop bar itself is the SHELL's chrome (NoteWorkspace.svelte), not
   * this component's: it spans the whole note pane, which is wider than the
   * editor column this component occupies. That also means the native shells
   * cannot accidentally get a web bar on top of their own — they never mount
   * NoteWorkspace. */
  let findBar: FindBarState = {
    open: false,
    query: '',
    label: '',
    hasMatches: false,
    focusToken: 0,
  };

  function emitFindState(next: Partial<FindBarState>): void {
    findBar = { ...findBar, ...next };
    props.onfindstate?.(findBar);
  }

  /* Find in note (docs/spec/editor.md). These five are the futoBridge v8 calls
   * both native shells make for their own find bars, and the desktop bar and
   * its Ctrl/Cmd+F / Ctrl/Cmd+G accelerators reach the engine through the same
   * three of them — one implementation, three platforms (M10). */
  function openFind(): void {
    const view = pmView();
    if (!view) return;
    openFindIn(view);
    /* Unconditionally, and AFTER the open: Ctrl/Cmd+F with the bar already up
     * on the same query changes nothing the plugin reports, so the bar would
     * never hear about it — and refocusing the query field is the whole point
     * of that second press (docs/spec/editor.md). */
    emitFindState({ open: true, focusToken: findBar.focusToken + 1 });
  }

  function setFindQuery(query: string): void {
    const view = pmView();
    if (view) setFindQueryIn(view, query);
  }

  function stepFind(direction: 1 | -1): void {
    const view = pmView();
    if (view) stepFindIn(view, direction);
  }

  /* The bar covering the bottom of the viewport, so a stepped-to match is
   * never scrolled UNDER it. iOS declares its bar's height here; the desktop
   * panel measures itself and reports through the same path; Android's bar is
   * a layout sibling and declares nothing. */
  function setFindOverlayInset(bottomOverlayPx: number): void {
    const view = pmView();
    if (view) setFindOverlayInsetIn(view, bottomOverlayPx);
  }

  /* `restoreOrigin` is the native shells' close (docs/spec/editor.md: closing
   * restores the editor selection and viewport from before find opened). The
   * desktop bar's own Escape passes `returnFocus` instead and leaves the
   * selection on the current match. */
  function closeFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { restoreOrigin: true });
  }

  /* The DESKTOP bar's close: leaves the selection on the current match and
   * hands focus back to the editor (docs/spec/editor.md). The native shells'
   * `closeFind` above restores the pre-find selection and viewport instead. */
  function dismissFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { returnFocus: true });
  }

  return {
    emitFindState,
    openFind,
    setFindQuery,
    stepFind,
    setFindOverlayInset,
    closeFind,
    dismissFind,
  };
}
