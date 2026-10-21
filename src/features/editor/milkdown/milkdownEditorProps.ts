import type { EditorLinkGesture } from '../editorLinkGesture';
import type { MobileDndHapticKind } from './mobileBlockDnd';
import type { FindBarState, FindMatchReport } from './find';
import type { DocumentRef, FlushFailureReason } from '@futo-notes/editor';

export interface Props {
  content?: string;
  onchange?: (content: string, ref: DocumentRef, flushToken?: string) => void;
  onedited?: (ref: DocumentRef) => void;
  ondocumentloaded?: (ref: DocumentRef, source: 'load' | 'external') => void;
  onflushfailed?: (ref: DocumentRef, token: string, reason: FlushFailureReason) => void;
  onexternalrefused?: (ref: DocumentRef) => void;
  onfocuschange?: (focused: boolean) => void;
  oncompositionend?: () => void;
  oncursorcontext?: (ctx: { onListLine: boolean; inContainer: boolean }) => void;
  nativeShell?: boolean;
  onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
  onopenurl?: (url: string) => void;
  /* Notion-style native toolbar active-state (iOS only for now — see
   * bridge.ts FormatStateMessage and issue #104 for the Android consumer).
   * Fires deduped whenever the set of active toolbar-manifest ids at the
   * cursor/selection changes. */
  onformatstate?: (active: string[], disabled: string[]) => void;
  /* Notion-style block drag haptics, from the long-press path both native
   * shells mount (see bridge.ts HapticMessage / mobileBlockDnd.ts). */
  onhaptic?: (kind: MobileDndHapticKind) => void;
  /* Whether a block is airborne on that same long-press path. A shell whose
   * WebView runs its own text-interaction gestures suspends them while it is
   * (bridge.ts BlockDragMessage) — on iOS nothing the page can do stops the
   * OS magnifier. */
  onblockdrag?: (active: boolean) => void;
  /* Whether a finger is DOWN on a block on that same path — posted at
   * touch-down, so a shell can stand its WebView's DELAYED long-press
   * recognizers down before they can win, instead of waiting for a lift that
   * may not come (bridge.ts BlockPressMessage / mobileBlockDnd.ts). */
  onblockpress?: (pressed: boolean) => void;
  /* Find in note's `{query, current, total, label}` report, for the native
   * bars (bridge.ts FindMatchesMessage). Deduped by the engine, and posted
   * whether or not this build renders the desktop panel. */
  onfindmatches?: (report: FindMatchReport, ref: DocumentRef) => void;
  /* Everything a find bar renders, deduped. The desktop shell draws its bar
   * from this; the native shells ignore it and read `onfindmatches`. */
  onfindstate?: (state: FindBarState) => void;
  /** The note stays readable but takes no edits: its vault refuses writes. */
  readonly?: boolean;
  /* The editor engine is up and holding a document. Milkdown's
   * `Editor.make().create()` is ASYNC, so Svelte's `mount()` returns long
   * before this — and the Android WebView gate used to read the host API that
   * mount() publishes as proof the engine works. On a Chromium 83 WebView
   * that meant a blank pane and no "update System WebView" notice
   * (docs/spec/editor.md; tests/editor-embed-webview-floor.spec.ts). This is
   * the honest signal. */
  onenginemounted?: () => void;
}
