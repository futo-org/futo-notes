/*
 * The editor's assembly: every ctx setting and every plugin it mounts, in
 * mount order — adding or removing a plugin is a change here and nowhere
 * else. Where an order matters, the line that depends on it says so.
 *
 * MilkdownEditor.svelte calls `assembleEditor` once, from onMount, and
 * `create()`s the result. Everything a plugin calls back into reaches it
 * through `EditorAssembly`, and every value that can change is a getter, read
 * when the plugin asks — never a snapshot taken at mount.
 */
import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { codeBlockAttr, inlineCodeAttr } from '@milkdown/kit/preset/commonmark';
import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
/* `gapCursorPlugin` only — NOT the whole `cursor` bundle. Its drop-indicator
 * half draws two lines per top-level gap; the ⠿ handle's drag draws its own
 * single line (`blockDragSession.ts`) and does not use it. */
import { gapCursorPlugin } from '@milkdown/kit/plugin/cursor';
import { trailing } from '@milkdown/kit/plugin/trailing';
import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { DocumentRef } from '@futo-notes/editor';
import type { ImageInsertTarget } from '../imageInsertTarget';
import { readOnlyGuard } from './readOnlyGuard';
import { useBlockDragPlugins } from './blockDrag.svelte';
import { autolink } from './autolink';
import { dividerCaretFix } from './dividerCaret';
import { plainTextBlockPaste } from './plainTextBlockPaste';
import { handleIndentShortcut, handleParityKeyDown } from './keyboardParity';
import { handleLineStartShortcut, softBreakView } from './paragraphLines';
import type { MobileDndHapticKind } from './mobileBlockDnd';
import { codeHighlight } from './codeHighlight';
import { createSelectionToolbarPlugin } from './selectionToolbar';
import { createSlashMenuPlugin } from './slash';
import { stripLeadingBoms } from './parseNote';
import { createFindMatchReport, findEngine, type FindBarState, type FindMatchReport } from './find';
import { tagDecorations } from './tagDecorations';
import { documentChanges } from './documentChanges';
import { taskCheckbox } from './taskCheckbox';
import { tableGrips } from './table/tableGrips';
import { imageInputRule } from './imageInputRule';
import { vaultImageView } from './vaultImageView';
import { wikilink } from './wikilink';

/** What the keyboard is told inside code, where its help is corruption.
 * Deliberately the inverse of the editable root's set (see the
 * `editorViewOptionsCtx` block below): squiggles stay off in both. */
const CODE_IME_ATTRIBUTES = {
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
  writingsuggestions: 'false',
} as const;

/** The component props a plugin calls back into. Getters: each read is the CURRENT prop. */
export interface EditorPluginProps {
  readonly nativeShell: boolean;
  readonly readonly: boolean;
  readonly onfocuschange?: (focused: boolean) => void;
  readonly onfindmatches?: (report: FindMatchReport, ref: DocumentRef) => void;
  readonly onhaptic?: (kind: MobileDndHapticKind) => void;
  readonly onblockdrag?: (active: boolean) => void;
  readonly onblockpress?: (pressed: boolean) => void;
}

/** Everything the assembled editor reads from, and calls back into, MilkdownEditor.svelte. */
export interface EditorAssembly {
  /** The element the editor mounts into. */
  container: HTMLElement;
  props: EditorPluginProps;
  /** The gates: which drag path, and whether the desktop-only menus, this editor mounts. */
  useMobileBlockDnd: () => boolean;
  useSlashMenu: () => boolean;
  useSelectionToolbar: () => boolean;
  getEditor: () => Editor | null;
  /** The note to open with, if the host sent one before the engine was up. */
  getPendingContent: () => string | null;
  getPasteHandler: () => ((event: ClipboardEvent) => boolean) | null;
  getDropHandler: () => ((event: DragEvent) => boolean) | null;
  isLoadFailed: () => boolean;
  getCurrentNoteId: () => string | null;
  getDocumentGeneration: () => number;
  getDocumentIdentity: () => number;
  imageTarget: ImageInsertTarget;
  pmView: () => ProseView | null;
  flush: () => void;
  emitCursorContext: (selectionOverride?: ProseSelection) => void;
  emitFormatState: (selectionOverride?: ProseSelection) => void;
  emitFindState: (next: Partial<FindBarState>) => void;
  nudgeBlockHandle: (clientY: number) => void;
  /** A user edit (documentChanges.ts). */
  documentEdited: () => void;
}

/** The ctx settings: the editable's view props, code IME traits, listeners. */
function configureEditor(ctx: Ctx, assembly: EditorAssembly): void {
  const {
    container,
    props,
    useMobileBlockDnd,
    getPendingContent,
    getPasteHandler,
    getDropHandler,
    isLoadFailed,
    pmView,
    flush,
    emitCursorContext,
    emitFormatState,
    nudgeBlockHandle,
  } = assembly;
  ctx.set(rootCtx, container);
  ctx.set(defaultValueCtx, stripLeadingBoms(getPendingContent() ?? ''));
  /* The editable's IME behavior.
   *
   * Red squiggles off, iOS autocorrect ON. Those are separate
   * attributes and the first version of this hook set both off, which
   * silently took autocorrect and predictive text away from every note
   * typed in the native shells — the swap's most-noticed regression
   * ("can we get autocorrect back?", 2026-09-01). `spellcheck: false`
   * is the one that drops the underlines; `autocorrect`/
   * `autocapitalize` are what the keyboard reads.
   *
   * `editorViewOptionsCtx` is Milkdown's sanctioned hook into the
   * ProseMirror `DirectEditorProps` (they are spread straight into
   * `new EditorView(...)`), so the attributes land on the
   * contenteditable through ProseMirror's own render instead of a DOM
   * mutation WebKit's DOMObserver would fight. */
  /* `handlePaste` rides the same hook. It has to be a DIRECT view prop
   * rather than a plugin: ProseMirror consults direct props before
   * plugin props, and `.use(clipboard)` below would otherwise claim an
   * image paste as HTML content first. Returning true means "this was
   * an image, do not paste it as text". */
  /* `handleKeyDown` rides it for the same precedence reason: the
   * CM6-parity Enter/Tab behaviors in keyboardParity.ts must win over
   * the gfm preset's own table keymap (bare Enter there is
   * `exitTable`) without depending on plugin registration order. */
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    attributes: {
      ...(typeof prev.attributes === 'object' ? prev.attributes : {}),
      spellcheck: 'false',
      autocorrect: 'on',
      autocapitalize: 'sentences',
      /* Apple's inline Writing Tools suggestions stay off. */
      writingsuggestions: 'false',
      enterkeyhint: 'return',
    },
    handlePaste: (_view, event) => getPasteHandler()?.(event) ?? false,
    /* `handleDrop` rides it for the same precedence reason as
     * `handlePaste`: an OS file drop must be claimed before the
     * preset's own drop handling turns the file into text. An INTERNAL
     * block drag carries no files and is left entirely alone. */
    handleDrop: (_view, event) => getDropHandler()?.(event as DragEvent) ?? false,
    handleKeyDown: (view, event) =>
      handleIndentShortcut(view, event) || handleParityKeyDown(view, event),
    /* A block shortcut (`- `, `# `, …) typed at the start of a line
     * inside a paragraph starts that block from the line, for the same
     * precedence reason (paragraphLines.ts). */
    handleTextInput: (view, from, to, text) => handleLineStartShortcut(view, from, to, text),
    /* A note whose parse threw is shown read-only rather than as an
     * empty editable page. Typing into a document that is not the note
     * is the one gesture that could make the failure destructive.
     * `refreshEditable()` is what re-asks this. */
    editable: () => !isLoadFailed() && !props.readonly,
  }));

  /* ...but not in code, as far as the engine will allow. Autocorrect
   * belongs to prose: the first adversarial pass after turning it on
   * caught the keyboard rewriting a fence's contents — `dont` became
   * `don't` and `teh` became `Teh` inside a code block, which is silent
   * corruption of the one kind of text a user most needs left alone.
   *
   * MEASURED, iOS 26 simulator, 2026-09-01: WKWebView IGNORES these.
   * It reads the traits from the editing HOST (the contenteditable
   * root), not from the element the caret is in, so typing `teh dont`
   * inside a fence still lands `The don't` with these attributes set.
   * They are declared anyway because they are what the HTML spec says
   * (autocapitalize inherits down the tree), they cost nothing, and
   * Blink — Android's WebView — is expected to honour them, though that
   * is UNVERIFIED here: no Android device was available. Do not read
   * this block as "autocorrect is scoped to prose on iOS"; it is not.
   *
   * Nor is it a matter of telling the shell. Four mechanisms were built
   * and measured on the iOS 26 simulator on 2026-09-01, typing `teh
   * dont` through the software keyboard into a fence, with the vault
   * bytes as the oracle; all four still wrote `The don't`. The short version:
   * the traits are latched when the input session begins, UIKit never
   * asks the WKContentView for them, and a blur+refocus only appears to
   * work because it dismisses the keyboard. Flipping the ROOT's
   * attribute with the caret is therefore not just useless on iOS but
   * HARMFUL — a note whose caret opens inside a fence loses autocorrect
   * for the whole session, prose included (measured) — which is why the
   * attributes here are per-element and static. */
  ctx.set(codeBlockAttr.key, () => ({
    pre: CODE_IME_ATTRIBUTES,
    code: CODE_IME_ATTRIBUTES,
  }));
  ctx.set(inlineCodeAttr.key, () => ({ ...CODE_IME_ATTRIBUTES }));

  const listeners = ctx.get(listenerCtx);
  listeners.focus(() => props.onfocuschange?.(true));
  listeners.blur(() => {
    if (props.nativeShell) flush();
    props.onfocuschange?.(false);
  });
  listeners.selectionUpdated((_ctx, selection) => {
    const view = pmView();
    // Pass `selection` explicitly — see emitFormatState's doc comment
    // (MilkdownEditor.svelte) for why `pmView()!.state.selection` is one
    // step stale here.
    emitCursorContext(selection);
    emitFormatState(selection);
    // No hover on mobile — surface the handle for the block the
    // cursor now sits in (covers both real cursor moves and a tap
    // that placed the caret). Not applicable at all under the
    // long-press path — there is no handle to surface.
    if (!useMobileBlockDnd() && view) {
      try {
        const coords = view.coordsAtPos(selection.from);
        nudgeBlockHandle((coords.top + coords.bottom) / 2);
      } catch {
        // Position not currently measurable (e.g. mid-transaction); skip.
      }
    }
  });
  listeners.mounted(() => {
    emitFormatState();
  });
}

/** The editor, configured and with every plugin registered in order — not yet created. */
export function assembleEditor(assembly: EditorAssembly): Editor {
  const {
    props,
    useMobileBlockDnd,
    useSlashMenu,
    useSelectionToolbar,
    getEditor,
    getCurrentNoteId,
    getDocumentGeneration,
    getDocumentIdentity,
    imageTarget,
    emitFindState,
    documentEdited,
  } = assembly;
  let builder = Editor.make()
    .config((ctx) => configureEditor(ctx, assembly))
    .use(commonmarkWithCompat())
    // AFTER the preset, whose hardbreak node it re-registers (paragraphLines.ts).
    .use(softBreakView)
    .use(gfmWithCompat())
    .use(wikilink)
    .use(autolink)
    .use(vaultImageView)
    .use(imageInputRule)
    .use(history)
    .use(listener)
    .use(documentChanges(documentEdited))
    .use(readOnlyGuard(() => props.readonly))
    // BEFORE clipboard: its handlePaste must see a plain-text block first.
    .use(plainTextBlockPaste)
    .use(clipboard)
    .use(gapCursorPlugin)
    .use(trailing)
    // AFTER trailing (dividerCaret.ts's header comment says why).
    .use(dividerCaretFix)
    .use(
      findEngine({
        onMatches: (report) => {
          const currentNoteId = getCurrentNoteId();
          if (currentNoteId !== null)
            props.onfindmatches?.(report, {
              noteId: currentNoteId,
              generation: getDocumentGeneration(),
            });
        },
        onStateChange: (find) => {
          emitFindState({
            open: find.open,
            query: find.query,
            hasMatches: find.matches.length > 0,
            /* While a rescan is pending the match list is a frame stale, so
             * the previous label stands rather than flashing "0". */
            ...(find.scanPending && find.open
              ? {}
              : {
                  label: createFindMatchReport(find.query, find.currentIndex, find.matches.length)
                    .label,
                }),
          });
        },
      }),
    )
    .use(tagDecorations)
    .use(taskCheckbox)
    .use(codeHighlight)
    .use(tableGrips);

  // The long-press drag or the ⠿ handle, never both (blockDrag.svelte.ts).
  builder = useBlockDragPlugins(builder, useMobileBlockDnd(), {
    onHaptic: (kind) => props.onhaptic?.(kind),
    onDragActive: (active) => props.onblockdrag?.(active),
    onPressActive: (pressed) => props.onblockpress?.(pressed),
  });

  /* The `/` block menu (desktop only — slash/index.ts). Two steps because
   * that is Milkdown's own shape for a slash plugin: `slashFactory` puts the
   * ProseMirror plugin spec in a ctx slice, so the spec is installed in
   * `.config()` and the plugin pair goes through `.use()`. */
  if (useSlashMenu()) {
    const slashMenu = createSlashMenuPlugin(getEditor, imageTarget);
    builder = builder.config(slashMenu.config).use(slashMenu.plugins);
  }

  /* The selection toolbar (desktop only — selectionToolbar/index.ts), the
   * same two-step shape: `tooltipFactory` puts the ProseMirror plugin spec
   * in a ctx slice, so the spec is installed in `.config()` and the plugin
   * pair goes through `.use()`. */
  if (useSelectionToolbar()) {
    const selectionToolbar = createSelectionToolbarPlugin(getEditor, getDocumentIdentity);
    builder = builder.config(selectionToolbar.config).use(selectionToolbar.plugins);
  }

  return builder;
}
