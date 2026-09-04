<script lang="ts">
  /*
   * The FUTO Notes editor: Milkdown (ProseMirror), WYSIWYG.
   *
   * THE editor on every surface — the desktop shell mounts it through
   * `NoteWorkspace.svelte`, and the native iOS/Android shells mount the same
   * component inside `editor.html` through `src/editor-embed/main.ts`. There is
   * one engine and one plugin set, so a behavior is identical on all three by
   * construction rather than by three code paths agreeing.
   *
   * ROUND-TRIP CONTRACT (ADR-0002): Milkdown parses and re-serializes markdown
   * through remark, so saving normalizes syntax (list markers, emphasis
   * delimiters, spacing, a trailing newline). Normalizing on a real edit is
   * accepted; normalizing on OPEN is not. `getContent()` therefore returns the
   * host's ORIGINAL bytes for as long as the document is still exactly what
   * loaded, so opening and closing a note can never rewrite it on disk.
   * `editor-embed-milkdown.spec.ts` locks that.
   *
   * What lives elsewhere: drop-target geometry (`blockDragGeometry.ts`), the
   * block move itself (`blockMove.ts`), the native shells' long-press drag
   * (`mobileBlockDnd.ts`; the desktop ⠿ handle's drag is @milkdown/plugin-block's
   * own), toolbar commands (`toolbarExec.ts`) and the native toolbar's
   * active-state (`formatState.ts`).
   */
  import { onMount } from 'svelte';
  import {
    Editor,
    defaultValueCtx,
    editorViewOptionsCtx,
    parserCtx,
    remarkStringifyOptionsCtx,
    rootCtx,
  } from '@milkdown/kit/core';
  import { codeBlockAttr, inlineCodeAttr } from '@milkdown/kit/preset/commonmark';

  import { commonmarkWithCompat } from '@futo-notes/editor/milkdown-compat';
  import { gfm } from '@milkdown/kit/preset/gfm';
  import { history } from '@milkdown/kit/plugin/history';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { clipboard } from '@milkdown/kit/plugin/clipboard';
  import { cursor, dropCursorConfig } from '@milkdown/kit/plugin/cursor';
  import { trailing } from '@milkdown/kit/plugin/trailing';
  import { block, BlockProvider } from '@milkdown/kit/plugin/block';
  import { getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
  import { history as proseHistory, redoDepth, undoDepth } from '@milkdown/kit/prose/history';
  import { EditorState, TextSelection, type PluginKey } from '@milkdown/kit/prose/state';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import {
    Slice,
    type Node as ProseNode,
    type Schema as ProseSchema,
  } from '@milkdown/kit/prose/model';
  import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
  import { imageReferenceMarkdown, withNarrowedAtxHashEscape } from '@futo-notes/editor';
  import { FRONTMATTER_NODE } from '@futo-notes/editor/milkdown-compat';
  import {
    installVaultImageUrlResolver,
    uninstallVaultImageUrlResolver,
  } from '$features/images/vaultImageUrlResolver';
  import { createImagePasteHandler, resolveImagePasteSink } from '../imagePasteSink';
  import type { EditorLinkGesture } from '../editorLinkGesture';
  import { resolveBlockContainment } from './blockContainment';
  import { resolveBlockDragMode } from './blockDragMode';
  import { editorView, enclosingListItem, isTaskItem } from './caretContext';
  import { computeActiveFormats } from './formatState';
  import { handleParityKeyDown } from './keyboardParity';
  import { createMobileBlockDndPlugin, type MobileDndHapticKind } from './mobileBlockDnd';
  import { codeHighlight } from './codeHighlight';
  import { createSlashMenuPlugin, resolveSlashMenu } from './slash';
  import { planMarkdownChunks, type MarkdownChunkOptions } from './markdownChunks';
  import {
    OPEN_COMPLETE_MEASURE,
    OPEN_INTERACTIVE_MEASURE,
    appendChunkContent,
    chunkShouldHaveContent,
    isEffectivelyEmpty,
    markOpenStart,
    measureOpen,
    scheduleIdleSlice,
    startProgressiveLoad,
    type ProgressiveLoad,
  } from './progressiveLoad';
  import { tagDecorations } from './tagDecorations';
  import { CHECKBOX_SIZE_PX, taskCheckbox } from './taskCheckbox';
  import { createToolbarExec } from './toolbarExec';
  import { vaultImageView } from './vaultImageView';
  import { refreshWikilinkViews, wikilink, WIKILINK_TARGET_ATTR } from './wikilink';
  import { WIKILINK_BROKEN_CLASS } from './wikilink/display';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    nativeShell?: boolean;
    onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
    onopenurl?: (url: string) => void;
    /* Notion-style native toolbar active-state (iOS only for now — see
     * bridge.ts FormatStateMessage and issue #104 for the Android consumer).
     * Fires deduped whenever the set of active toolbar-manifest ids at the
     * cursor/selection changes. */
    onformatstate?: (active: string[]) => void;
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
     * recognisers down before they can win, instead of waiting for a lift that
     * may not come (bridge.ts BlockPressMessage / mobileBlockDnd.ts). */
    onblockpress?: (pressed: boolean) => void;
    /* The editor engine is up and holding a document. Milkdown's
     * `Editor.make().create()` is ASYNC, so Svelte's `mount()` returns long
     * before this — and the Android WebView gate used to read the host API that
     * mount() publishes as proof the engine works. On a Chromium 83 WebView
     * that meant a blank pane and no "update System WebView" notice
     * (docs/spec/editor.md; tests/editor-embed-webview-floor.spec.ts). This is
     * the honest signal. */
    onenginemounted?: () => void;
  }

  let {
    content = '',
    onchange,
    onfocuschange,
    oncompositionend,
    oncursorcontext,
    onopenlink,
    onopenurl,
    onformatstate,
    nativeShell = false,
    onhaptic,
    onblockdrag,
    onblockpress,
    onenginemounted,
  }: Props = $props();

  /* THE single gate: the Notion-style long-press-anywhere-on-the-block path
   * REPLACES the ⠿ gutter handle in the native shells — iOS and Android both —
   * and the two never coexist for one editor. `blockDragMode.ts` owns the
   * decision (components do not read the platform — src/AGENTS.md).
   *
   * `$derived` (not a plain top-level read) so the gutter CSS class and the
   * tap handlers stay wired to the `nativeShell` prop rather than to a
   * snapshot. Which PLUGIN gets mounted is still decided once, in onMount —
   * the embed never flips `nativeShell` on a live editor, and swapping drag
   * mechanisms under a mounted ProseMirror view is not something this
   * supports. */
  const useMobileBlockDnd = $derived(resolveBlockDragMode(nativeShell) === 'long-press');
  /* The `/` block menu, desktop only (slash/index.ts `resolveSlashMenu`).
   * Same one-shot read as useMobileBlockDnd above: the plugin set is fixed when
   * the engine is built. */
  const useSlashMenu = $derived(resolveSlashMenu(nativeShell) === 'enabled');
  /* Apple WebKit paints holes where a contained block should be — see
   * blockContainment.ts. The class, not the rule, is what varies. */
  const skipOffscreenBlocks = resolveBlockContainment() === 'offscreen-skipped';

  /** What the keyboard is told inside code, where its help is corruption.
   * Deliberately the inverse of the editable root's set (see the
   * `editorViewOptionsCtx` block below): squiggles stay off in both. */
  const CODE_IME_ATTRIBUTES = {
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    writingsuggestions: 'false',
  } as const;

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The markdown the HOST last handed us, kept verbatim while the document is
   * still exactly what it loaded, so an open/close cycle cannot rewrite a note
   * on disk in Milkdown's normalized syntax. */
  let hostMarkdown: string | null = null;
  /* Milkdown's own serialization of the current doc; null until something has
   * actually been loaded. It must NOT start as `''`: an empty string is also a
   * legitimate serialization, so a placeholder `''` made `setContent('')` — a
   * brand-new note — look like content we already held, skip `applyExternal`,
   * and leave `externalSerialization` unset, which switches the load-echo guard
   * in getContent() off for exactly that note. */
  let liveMarkdown: string | null = null;
  /* Milkdown's serialization of the doc AS LOADED from the host. The listener
   * plugin debounces markdownUpdated by 200ms, so a synchronous "we are
   * applying host content" flag cannot suppress the load echo — comparing
   * against this can. */
  let externalSerialization: string | null = null;
  let pendingContent: string | null = null;
  let onListLine: boolean | null = null;

  /* The in-flight progressive open, if this note was large enough to stream
   * (progressiveLoad.ts). Null the rest of the time, which is every note in an
   * ordinary vault. */
  let progressive: ProgressiveLoad | null = null;
  /* Drives the loading affordance over the streaming tail. `$state` because it
   * is read by the template. */
  let streamingTail = $state(false);
  /* Undo depth when the current progressive load started — the baseline the
   * "did the user type while the tail was streaming?" question is asked
   * against. A plain `undoDepth > 0` test would be wrong: the host calls
   * `resetHistory()` after every setContent/initialize (so the baseline is
   * usually 0), but `applyExternalContent` — a remote sync update — does NOT,
   * and there the user's earlier history is still on the stack. Reading that as
   * an edit would make adopting a sync update rewrite a large note on disk,
   * which ADR-0002 forbids. `resetHistory()` below keeps this in step. */
  let historyBaselineDepth = 0;
  /* Set at load completion, consumed by the next change notification — see the
   * markdownUpdated listener for the stale-snapshot it defends against. */
  let listenerSnapshotMayBeStale = false;
  /* Whether the last load gave up on chunking mid-flight and reloaded the note
   * whole. Reported by `censusLoad` so the equivalence census cannot score a
   * fallback as proof that a chunked parse matched a whole one — it would be
   * comparing a whole parse against a whole parse. */
  let abortedToWholeDocument = false;

  /* Notion-style block drag handle. BlockProvider (from Milkdown's block
   * plugin) owns rendering/positioning the ⠿ handle and the native HTML5 drag
   * mechanics; we just feed it a DOM node and, on touch where there is no
   * hover, nudge it to show for the block under the cursor/tap by dispatching a
   * synthetic pointermove — the SAME event the plugin's own hover detection
   * listens for, so selection/tap and mouse-hover resolve to identical block
   * boundaries. Dragging the handle is the block plugin's own HTML5 drag. */
  let blockProvider: BlockProvider | null = null;

  /* prosemirror-history keeps its PluginKey module-private, so take it off a
   * throwaway instance of the very same plugin factory Milkdown's history
   * plugin uses — exact identity, no name matching. */
  const HISTORY_KEY = proseHistory().spec.key as PluginKey<unknown>;

  /** The plugin state a freshly created history plugin starts with. */
  function emptyHistoryState(schema: ProseSchema): unknown {
    return HISTORY_KEY.getState(EditorState.create({ schema, plugins: [proseHistory()] }));
  }

  const pmView = (): ProseView | null => editorView(editor);

  /* ---- images ------------------------------------------------------------ *
   * Vault images are bare filenames; `vaultImageView.ts` is the ProseMirror
   * node view that resolves each one against whatever this shell serves the
   * vault over, and re-resolves itself when that arrives late. Nothing here
   * touches rendered image DOM — a post-render sweep is what the node view
   * replaced (see that file's header for the three bugs it had).
   *
   * Pasting an image is `pasteHandler` below: `imagePasteSink.ts` decides how
   * THIS host captures the bytes, and this component only inserts whatever
   * filename comes back. */
  let pasteHandler: ((event: ClipboardEvent) => boolean) | null = null;
  /* Only true where this editor installed the per-file URL producer (Tauri
   * desktop), so the teardown removes exactly what the mount added. */
  let ownsImageUrlResolver = false;

  /* Sorted comma-joined snapshot of the last emitted format-state set, so
   * emitFormatState() below can dedupe without the caller tracking it. */
  let lastFormatStateKey: string | null = null;

  /**
   * Emits deduped `formatState`. `selectionOverride`, when given, is the
   * SELECTION-JUST-APPLIED from Milkdown's `selectionUpdated` listener
   * callback — pass it explicitly rather than reading `pmView()!.state`
   * there: Milkdown's listener plugin runs that callback from inside
   * `EditorState.apply(tr)`, before the default `dispatchTransaction` calls
   * `view.updateState(...)`, so `view.state` (and its `.selection`/
   * `.storedMarks`) is still ONE TRANSACTION BEHIND at that exact call site —
   * `pmView()?.state.selection` there would report where the caret USED TO
   * BE. `mounted`/`markdownUpdated`(debounced)/`exec()` all run outside that
   * window, so `view.state` is current for them (no override needed) — and
   * `storedMarks` is intentionally omitted (`null`) for the override case: a
   * plain selection-move transaction always clears storedMarks anyway, so
   * `selection.$from.marks()` alone is correct there, whereas `exec('bold')`
   * on a collapsed selection genuinely relies on the freshly toggled
   * `view.state.storedMarks` to report active immediately.
   */
  function emitFormatState(selectionOverride?: ProseSelection): void {
    if (!onformatstate) return;
    /* A streaming progressive open moves the selection with every chunk it
     * appends, and there is no toolbar tap behind any of it — recomputing
     * would be per-chunk work on the load path for a highlight nobody asked
     * for. The completion path emits once, for the finished document. */
    if (progressive?.loading) return;
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const storedMarks = selectionOverride ? null : view.state.storedMarks;
    const active = computeActiveFormats(view, selection, storedMarks);
    const key = [...active].sort().join(',');
    if (key === lastFormatStateKey) return;
    lastFormatStateKey = key;
    onformatstate(active);
  }

  /**
   * Emits deduped `cursorContext` — Indent/Outdent visibility. Takes the same
   * `selectionOverride` as `emitFormatState`, and for the same reason.
   */
  function emitCursorContext(selectionOverride?: ProseSelection): void {
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const inList = enclosingListItem(selection) !== null;
    if (inList === onListLine) return;
    onListLine = inList;
    oncursorcontext?.({ onListLine: inList });
  }

  const EXEC = createToolbarExec(() => editor);

  /* Task-list glyphs are painted via an outdented `::before` on the <li>
   * (see the `li[data-checked]::before` rule below) that the block handle's
   * own bounding box does not know about — push the handle further left for
   * those items so the handle and the checkbox are never the same tap. */
  function blockHandleOffset(node: ProseNode): { mainAxis: number } {
    return isTaskItem(node) ? { mainAxis: 30 } : { mainAxis: 8 };
  }

  /* Drives the block plugin's own hover-detection path (BlockService listens
   * for `pointermove` on the ProseMirror DOM) so tap/selection reuse the exact
   * same block-boundary resolution as desktop mouse hover, instead of a
   * hand-rolled second implementation that could disagree with it. */
  function nudgeBlockHandle(clientY: number): void {
    const view = pmView();
    if (!view) return;
    const rect = view.dom.getBoundingClientRect();
    const evt = new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(evt);
  }

  /* The handle's position is only recomputed when the plugin shows/hides it;
   * without this it would visually drift over the wrong block while the user
   * scrolls, whichever element is carrying the scroll. */
  function handleBlockScroll(): void {
    blockProvider?.hide();
  }

  onMount(() => {
    let disposed = false;

    // Read the initial prop here rather than at the top level: the embed host
    // feeds content through setContent, and a top-level read is a Svelte 5
    // "captures only the initial value" warning.
    if (content) {
      pendingContent = content;
      hostMarkdown = content;
      liveMarkdown = content;
    }
    container.addEventListener('click', handleClick);
    // Not passive: the handler must be able to preventDefault a link tap.
    container.addEventListener('touchend', handleTouchEnd, { passive: false });

    (async () => {
      let builder = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, pendingContent ?? '');
          // The drop indicator ships via `.use(cursor)`; its default color is
          // `false` (invisible) unless configured.
          ctx.set(dropCursorConfig.key, {
            width: 3,
            color: 'var(--color-primary, #f26b1f)',
            class: 'milkdown-drop-indicator',
          });

          /* Stop remark-stringify turning a note's leading `#tag` into `\#tag`
           * on save, which silently un-tags it. See
           * packages/editor/src/milkdown-compat/atxEscape.ts — Milkdown's own
           * `text` handler is what gets wrapped, so its behavior is preserved
           * and only the escape condition narrows. */
          ctx.update(remarkStringifyOptionsCtx, (options) => {
            // Milkdown always installs its own `text` handler, and this wraps
            // that one rather than replacing it. If it ever stops, leaving the
            // serializer alone is the safe answer here — and the regression is
            // not silent: `editor-embed-milkdown-parity.spec.ts` asserts that
            // saving a note does not escape its tags.
            const text = options.handlers?.text;
            if (!text) return options;
            return {
              ...options,
              handlers: { ...options.handlers, text: withNarrowedAtxHashEscape(text) },
            };
          });

          /* `-` for bullet markers, not remark-stringify's default `*`.
           * The manifest's Bullet/Task buttons emit `- `, and so does the
           * overwhelming majority of the corpus, so `*` would make every
           * edited note churn its list markers on the first save for no reason
           * (ADR-0002 normalize-once). */
          ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));

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
            handlePaste: (_view, event) => pasteHandler?.(event) ?? false,
            handleKeyDown: (view, event) => handleParityKeyDown(view, event),
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
           * bytes as the oracle; all four still wrote `The don't`. The list, so
           * nobody pays for it twice, is in docs/spec/editor.md under the
           * "autocorrect still rewrites code on iOS" Gap. The short version:
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
          listeners.markdownUpdated((_ctx, reported) => {
            /* `reported` is @milkdown/plugin-listener's serialization of the
             * document as it stood in the transaction that STARTED the 200 ms
             * debounce (`latestTr.doc`), not the live one — and the plugin
             * skips `addToHistory: false` transactions entirely, which is
             * exactly what a streamed chunk append is. So the first callback
             * after a progressive open can carry the note as it stood
             * MID-STREAM: a truncated document, arriving one debounce window
             * after the save lock lifted. Re-read the live document for that
             * one callback rather than trust it. */
            emitFormatState();
            /* SAVE LOCK (CRITICAL — progressiveLoad.ts): while the tail is
             * streaming the document is a PREFIX of the note. Reporting it as a
             * change is how a slow open truncates a file, and `liveMarkdown`
             * must not take a prefix either — `setContent` dedupes against it.
             * An edit made in this window is not lost: finishProgressiveLoad()
             * releases it against the complete document. */
            if (progressive?.loading) return;

            let markdown = reported;
            if (listenerSnapshotMayBeStale) {
              listenerSnapshotMayBeStale = false;
              markdown = readSerialized() ?? reported;
            }
            liveMarkdown = markdown;
            // The debounced echo of host content we just loaded — not an edit.
            if (externalSerialization !== null && markdown === externalSerialization) return;
            // A genuine user edit: the host's copy is no longer authoritative.
            externalSerialization = null;
            hostMarkdown = null;
            onchange?.(markdown);
          });
          listeners.focus(() => onfocuschange?.(true));
          listeners.blur(() => onfocuschange?.(false));
          listeners.selectionUpdated((_ctx, selection) => {
            const view = pmView();
            // Pass `selection` explicitly — see emitFormatState's doc comment
            // for why `pmView()!.state.selection` is one step stale here.
            emitCursorContext(selection);
            emitFormatState(selection);
            // No hover on mobile — surface the handle for the block the
            // cursor now sits in (covers both real cursor moves and a tap
            // that placed the caret). Not applicable at all under the
            // long-press path — there is no handle to surface.
            if (!useMobileBlockDnd && view) {
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
        })
        .use(commonmarkWithCompat())
        .use(gfm)
        .use(wikilink)
        .use(vaultImageView)
        .use(history)
        .use(listener)
        .use(clipboard)
        .use(cursor)
        .use(trailing)
        .use(tagDecorations)
        .use(taskCheckbox)
        .use(codeHighlight);

      // THE single native-shell gate (see useMobileBlockDnd above): the
      // Notion-style long-press-anywhere-on-the-block path REPLACES the ⠿
      // gutter handle plugin entirely for this editor instance — the two never
      // coexist.
      builder = useMobileBlockDnd
        ? builder.use(
            createMobileBlockDndPlugin({
              onHaptic: (kind) => onhaptic?.(kind),
              onDragActive: (active) => onblockdrag?.(active),
              onPressActive: (pressed) => onblockpress?.(pressed),
            }),
          )
        : builder.use(block);

      /* The `/` block menu (desktop only — slash/index.ts). Two steps because
       * that is Milkdown's own shape for a slash plugin: `slashFactory` puts the
       * ProseMirror plugin spec in a ctx slice, so the spec is installed in
       * `.config()` and the plugin pair goes through `.use()`. */
      if (useSlashMenu) {
        const slashMenu = createSlashMenuPlugin(() => editor);
        builder = builder.config(slashMenu.config).use(slashMenu.plugins);
      }

      const created = await builder.create();

      if (disposed) {
        void created.destroy();
        return;
      }

      editor = created;
      // Here, not after the chrome below and not after the first document is
      // parsed: the question this answers is "can this WebView run the editor
      // engine", and tying it to a parse would make a big note look like an
      // unsupported WebView on a slow phone (the host's boot grace is 10 s).
      onenginemounted?.();
      if (pendingContent !== null && pendingContent !== '') {
        applyExternal(pendingContent);
      }
      pendingContent = null;

      pasteHandler = createImagePasteHandler({
        sink: resolveImagePasteSink(),
        insertImage: (filename) => insertMarkdown(imageReferenceMarkdown(filename)),
      });
      /* Where images resolve per file rather than off a host base URL (Tauri
       * desktop), the node views need something to ask. */
      ownsImageUrlResolver = installVaultImageUrlResolver();

      if (!useMobileBlockDnd) {
        const handleEl = document.createElement('div');
        handleEl.className = 'milkdown-block-handle';
        handleEl.textContent = '⠿';
        handleEl.setAttribute('aria-hidden', 'true');
        blockProvider = new BlockProvider({
          ctx: created.ctx,
          content: handleEl,
          getOffset: (deriveContext) => blockHandleOffset(deriveContext.active.node),
        });
        blockProvider.update();
        // On `document`, in the CAPTURE phase, because scroll events do not
        // bubble and WHICH element scrolls depends on the host: the editable
        // itself in the embed, the shell's `.note-body` on desktop (see the
        // `.notes-shell` CSS rule below). Listening on the editable alone left
        // the handle floating over the wrong block for every desktop scroll —
        // and desktop is the only host that has a handle at all.
        document.addEventListener('scroll', handleBlockScroll, {
          passive: true,
          capture: true,
        });
      }
    })().catch((error: unknown) => {
      // An engine that cannot build the editor is the whole reason the WebView
      // gate exists, and this used to be an unhandled rejection — invisible to
      // everything. Swallowing it is still the right shape: onenginemounted
      // never fired, so the host's probe keeps answering 'pending' and its
      // grace period turns that into the update-WebView notice.
      console.error('MilkdownEditor: the editor engine failed to start', error);
    });

    return () => {
      disposed = true;
      progressive?.cancel();
      progressive = null;
      if (ownsImageUrlResolver) {
        uninstallVaultImageUrlResolver();
        ownsImageUrlResolver = false;
      }
      container.removeEventListener('click', handleClick);
      container.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('scroll', handleBlockScroll, { capture: true });
      blockProvider?.destroy();
      blockProvider = null;
      const current = editor;
      editor = null;
      void current?.destroy();
    };
  });

  function readSerialized(): string | null {
    if (!editor) return null;
    try {
      return editor.action(getMarkdown());
    } catch {
      return null;
    }
  }

  /** Loads the whole document in one parse — what every ordinary note does. */
  function applyWholeDocument(text: string): void {
    if (!editor) return;
    editor.action(replaceAll(text));
    hostMarkdown = text;
    liveMarkdown = text;
    externalSerialization = readSerialized() ?? text;
  }

  /**
   * Whether the last chunk applied ended in an empty paragraph of its OWN — a
   * `<br />` placeholder an older build wrote as its final block. The next
   * append must then keep the live document's trailing empty paragraph rather
   * than treat it as the `trailing` plugin's (see `appendChunkContent`).
   */
  let previousChunkEndedEmpty = false;

  /**
   * An empty paragraph at the end of a parsed chunk is the chunk's own unless
   * it is the schema's: a chunk that is nothing but front matter gets one from
   * `createAndFill`, because the doc's content is `frontmatter? block+` and the
   * front matter is not a block. That one belongs to the FINISHED document's
   * shape, not to this chunk, and the whole-document parse never has it (the
   * body's first block satisfies `block+`). Measured: four corpus notes with
   * front matter opened one blank line longer chunked than whole before this.
   */
  function endsWithOwnEmptyParagraph(node: ProseNode): boolean {
    const last = node.lastChild;
    if (last === null || last.type.name !== 'paragraph' || last.content.size !== 0) return false;
    const isFrontmatterFiller =
      node.childCount === 2 && node.firstChild?.type.name === FRONTMATTER_NODE;
    return !isFrontmatterFiller;
  }

  /**
   * Mounts the first chunk, replacing whatever the editor held.
   *
   * Guarded exactly like every later chunk: a first chunk the plugin chain eats
   * would otherwise be dropped silently, and it is the one the user is looking
   * at. The parse is done here rather than through `replaceAll` (this is that
   * macro's non-flush body, verbatim) so the parsed chunk is in hand for the
   * guard and for `previousChunkEndedEmpty`.
   */
  function applyFirstChunk(markdown: string): boolean {
    const view = pmView();
    if (!editor || !view) return false;
    const parsed = editor.ctx.get(parserCtx)(markdown);
    if (!parsed) return false;
    if (chunkShouldHaveContent(markdown) && isEffectivelyEmpty(parsed)) return false;
    const { state } = view;
    view.dispatch(state.tr.replace(0, state.doc.content.size, new Slice(parsed.content, 0, 0)));
    previousChunkEndedEmpty = endsWithOwnEmptyParagraph(parsed);
    return true;
  }

  /**
   * Parses one streamed chunk and appends it, with the empty paragraphs the
   * seam before it stands for. Returns false if the parse failed, which aborts
   * the stream back to a whole-document load rather than silently dropping the
   * rest of the note.
   */
  function appendParsedChunk(markdown: string, leadingEmptyParagraphs: number): boolean {
    const view = pmView();
    if (!editor || !view) return false;
    try {
      const parsed = editor.ctx.get(parserCtx)(markdown);
      if (!parsed) return false;
      // Real markdown that parses to nothing has been eaten by the plugin
      // chain; appending it would drop that slice of the note.
      if (chunkShouldHaveContent(markdown) && isEffectivelyEmpty(parsed)) return false;
      appendChunkContent(view, parsed, {
        leadingEmptyParagraphs,
        consumeTrailingPlaceholder: !previousChunkEndedEmpty,
      });
      previousChunkEndedEmpty = endsWithOwnEmptyParagraph(parsed);
      return true;
    } catch (error) {
      console.warn('MilkdownEditor: chunk parse failed', error);
      return false;
    }
  }

  /**
   * Whether the user has made an undoable change since the current load began.
   *
   * Every user edit is history-recorded — that is what the history plugin is
   * for — while the editor's own housekeeping is not: the preset re-stamps
   * heading ids in a 125-step transaction after content lands, which a
   * "any document change that isn't ours" test misreads as typing, and which
   * would then rewrite every large note on open.
   */
  function editedSinceLoadStart(): boolean {
    const view = pmView();
    return view ? undoDepth(view.state) > historyBaselineDepth : false;
  }

  /**
   * The tail is in. Release the save lock, and with it any edit the user made
   * into the first viewport while the rest was still arriving.
   */
  function finishProgressiveLoad(): void {
    streamingTail = false;
    listenerSnapshotMayBeStale = true;
    measureOpen(OPEN_COMPLETE_MEASURE);
    emitFormatState();

    const complete = readSerialized();
    liveMarkdown = complete;
    /* Set even in the edited branch: it makes the listener's trailing debounced
     * callback — which is about to arrive carrying exactly this text — an echo
     * rather than a second, duplicate `change`. */
    externalSerialization = complete;

    if (!editedSinceLoadStart()) return;
    // The host's bytes are no longer what the document says.
    hostMarkdown = null;
    if (complete !== null) onchange?.(complete);
  }

  /**
   * Loads host content into the editor, progressively when the note is large
   * enough to be worth it (docs/plan/milkdown-transition.md §5).
   *
   * Progressive means the FIRST chunk is mounted synchronously — the user is
   * looking at a real, editable first viewport within one frame — and the rest
   * streams in idle slices. `markdownChunks.ts` guarantees the cuts are safe;
   * everything that could leak a half-loaded document (the `change`
   * notification, `getContent`) is locked until the last chunk lands.
   */
  function applyExternal(text: string, chunkOptions?: MarkdownChunkOptions): void {
    if (!editor) return;
    progressive?.cancel();
    progressive = null;
    streamingTail = false;
    abortedToWholeDocument = false;
    markOpenStart();

    const plan = planMarkdownChunks(text, chunkOptions);
    if (!plan.chunked) {
      applyWholeDocument(text);
      measureOpen(OPEN_INTERACTIVE_MEASURE);
      measureOpen(OPEN_COMPLETE_MEASURE);
      return;
    }

    hostMarkdown = text;
    liveMarkdown = text;
    /* No serialization of this document exists yet — it is still a prefix. The
     * save lock, not this field, is what protects the streaming window. */
    externalSerialization = null;

    /* A chunk the editor would not take. Nothing about progressive open is
     * worth risking content for: throw the partial document away and load the
     * note exactly the way it loaded before this feature existed. An edit made
     * into the first viewport during the streaming window is discarded with it
     * — vanishingly rare (it needs a note whose chunks the plugin chain eats
     * AND a keystroke inside a sub-second window) and strictly better than
     * appending a chunk that lost part of the note. */
    let index = 0;
    const abortToWholeDocument = (): void => {
      abortedToWholeDocument = true;
      progressive?.cancel();
      progressive = null;
      streamingTail = false;
      applyWholeDocument(text);
      measureOpen(OPEN_COMPLETE_MEASURE);
    };

    const load = startProgressiveLoad({
      chunks: plan.chunks,
      applyChunk: (markdown, leadingEmptyParagraphs) => {
        if (abortedToWholeDocument) return;
        const applied =
          index === 0
            ? applyFirstChunk(markdown)
            : appendParsedChunk(markdown, leadingEmptyParagraphs);
        index += 1;
        if (!applied) abortToWholeDocument();
      },
      scheduleIdle: scheduleIdleSlice,
      onComplete: () => {
        if (abortedToWholeDocument) return;
        finishProgressiveLoad();
      },
    });

    /* Chunk 0 is applied inside `startProgressiveLoad`, so an abort there ran
     * before `progressive` existed and could not cancel the load it is part of.
     * Everything else is already settled by `abortToWholeDocument`. */
    if (abortedToWholeDocument) {
      load.cancel();
      measureOpen(OPEN_INTERACTIVE_MEASURE);
      return;
    }

    progressive = load;
    streamingTail = load.loading;
    // After chunk 0: its replace is itself an undoable transaction, and
    // the host's `resetHistory()` (which drops this back to 0) only runs once
    // this returns.
    const view = pmView();
    historyBaselineDepth = view ? undoDepth(view.state) : 0;
    measureOpen(OPEN_INTERACTIVE_MEASURE);
  }

  /* Tapping a task-list marker toggles it (Milkdown renders the checkbox state
   * as a `data-checked` attribute; the glyph itself is CSS). */
  /* ---- link taps --------------------------------------------------------- *
   * Wikilinks and external links share ONE activation path on purpose. The
   * reason they need a `touchend` leg at all is engine-specific and applies to
   * both: on iOS WebKit a prevented mousedown cancels the synthetic click, so a
   * click-only handler dead-ends there while Chromium double-fires
   * (docs/spec/editor.md, "Wikilinks — navigation & integrity"). Splitting the
   * two would have left external links on the leg that dead-ends. */

  type EditorLink =
    { kind: 'wikilink'; title: string; broken: boolean } | { kind: 'external'; url: string };

  /** A wikilink chip is an anchor carrying the raw target; anything else with
   * an href leaves the app. Neither is a plain caret placement. */
  function linkAt(node: HTMLElement | null): EditorLink | null {
    const anchor = node?.closest('a');
    if (!anchor) return null;
    const title = anchor.getAttribute(WIKILINK_TARGET_ATTR);
    if (title !== null) {
      return { kind: 'wikilink', title, broken: anchor.classList.contains(WIKILINK_BROKEN_CLASS) };
    }
    const href = anchor.getAttribute('href') ?? '';
    return href ? { kind: 'external', url: href } : null;
  }

  /**
   * A tap on a BROKEN wikilink must not be swallowed. The host may do nothing
   * with it — the native embed posts `openNote` only for a resolved link, a
   * recorded spec Gap — and preventing the default as well would leave a dead
   * chip that can be neither followed nor repaired, since an atom node is
   * fixed by SELECTING and replacing it, not by editing inside it. Letting
   * ProseMirror have the event keeps the spec's intent ("a broken wikilink
   * still focuses, so it can be edited") reachable in the WYSIWYG model.
   */
  function consumesTap(link: EditorLink): boolean {
    return !(link.kind === 'wikilink' && link.broken);
  }

  const NEUTRAL_GESTURE: EditorLinkGesture = {
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };

  /* A touchend that activated a link suppresses its own synthetic click, but
   * belt-and-braces: a WebView that emits one anyway must not open the note
   * twice. */
  let lastLinkActivationMs = 0;
  const SYNTHETIC_CLICK_WINDOW_MS = 700;

  function activateLink(link: EditorLink, gesture: EditorLinkGesture): void {
    lastLinkActivationMs = Date.now();
    /* Broken links are posted too: what happens next is the HOST's call —
     * desktop opens an empty editor bound to the target text, the native embed
     * drops it (a recorded spec Gap). The editor does not resolve here. */
    if (link.kind === 'wikilink') onopenlink?.(link.title, gesture);
    else onopenurl?.(link.url);
  }

  function handleTouchEnd(event: TouchEvent): void {
    const link = linkAt(event.target as HTMLElement | null);
    if (!link) return;
    // Also stops WebKit turning the tap into a caret placement inside the chip.
    if (consumesTap(link)) event.preventDefault();
    activateLink(link, NEUTRAL_GESTURE);
  }

  /* Task checkboxes own their own taps — see taskCheckbox.ts, whose widget
   * both draws the box and toggles it. This handler is only links and the
   * tap-to-surface-the-drag-handle behavior. */
  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // BlockService already owns mousedown/dragstart on its own handle DOM.
    if (target.closest('.milkdown-block-handle')) return;

    const link = linkAt(target);
    if (link) {
      if (consumesTap(link)) event.preventDefault();
      if (Date.now() - lastLinkActivationMs > SYNTHETIC_CLICK_WINDOW_MS) {
        activateLink(link, {
          button: event.button === 1 ? 1 : 0,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        });
      }
      return;
    }

    // No hover on mobile — surface the drag handle for whatever block was
    // tapped. Not applicable under the long-press path (no handle).
    if (!useMobileBlockDnd) nudgeBlockHandle(event.clientY);
  }

  // ---- handle consumed by src/editor-embed ------------------------------- //

  export function setContent(text: string): void {
    if (!editor) {
      pendingContent = text;
      hostMarkdown = text;
      return;
    }
    if (text === hostMarkdown || text === liveMarkdown) return;
    applyExternal(text);
  }

  export function getContent(): string | undefined {
    /* SAVE LOCK (CRITICAL — docs/plan/milkdown-transition.md §5). A document
     * that is still streaming is a PREFIX of the note, and this method is one
     * of exactly two ways content leaves the editor (the other is the `change`
     * message, locked in the listener above). Neither branch below can return
     * a prefix. */
    if (progressive?.loading) {
      /* Untouched since the open: the host's own bytes ARE the whole note, and
       * they are exactly what is on disk. The correct answer, and free. */
      if (!editedSinceLoadStart()) return hostMarkdown ?? '';
      /* Edited: the only answer carrying both the edit and the tail costs the
       * rest of the parse. Pay it rather than hand back a prefix. */
      progressive.finishNow();
    }
    const live = readSerialized();
    if (live === null) return hostMarkdown ?? liveMarkdown ?? '';
    // Only hand back the host's original bytes while the document is still
    // EXACTLY what it loaded; a keystroke inside the listener's debounce window
    // must not be reported as the unmodified note.
    if (hostMarkdown !== null && live === externalSerialization) return hostMarkdown;
    return live;
  }

  export function focus(): void {
    pmView()?.focus();
  }

  export function blur(): void {
    pmView()?.dom.blur();
  }

  export function hasFocus(): boolean {
    return pmView()?.hasFocus() ?? false;
  }

  export function isComposing(): boolean {
    return Boolean(pmView()?.composing);
  }

  export function insertMarkdown(text: string): void {
    if (!editor) return;
    editor.action(insert(text));
    pmView()?.focus();
  }

  /**
   * Opens a note: load its text, then drop the undo stack that belonged to
   * whatever was open before.
   *
   * The reset is the load-bearing half. Without it the first Ctrl-Z after a
   * note switch replays the PREVIOUS note's steps into this document, and the
   * save that follows writes them to THIS note's file. See `resetHistory`.
   *
   * There is no note id here, and no per-note undo stash: the CodeMirror
   * editor kept one (`noteHistory.ts`, keyed by note id) and this engine does
   * not. Recorded as a Gap in docs/spec/editor.md.
   */
  export function openNote(text: string): void {
    if (!editor) {
      pendingContent = text;
      hostMarkdown = text;
      liveMarkdown = text;
      return;
    }
    applyExternal(text);
    resetHistory();
  }

  /**
   * Replace the whole document with `text` as the USER's own edit — undoable
   * in one step, and reported through `onchange` straight away.
   *
   * `setContent` is the HOST handing us a note (echo-guarded, silent); this is
   * the shell's chrome editing the note on the user's behalf. The desktop tag
   * bar is the caller (NoteTagBar.svelte): it computes new markdown from
   * `getContent()` and hands the whole document back, because a markdown
   * character offset has no ProseMirror position to splice at.
   *
   * `onchange` fires synchronously rather than waiting on the listener's
   * 200 ms debounce, so a tag the user just added is in the save queue before
   * they can navigate away. The debounced echo that follows is suppressed the
   * same way a completed progressive load suppresses its own.
   */
  export function applyEdit(text: string): void {
    if (!editor) return;
    editor.action(replaceAll(text));
    const live = readSerialized() ?? text;
    liveMarkdown = live;
    // The document is no longer the host's bytes.
    hostMarkdown = null;
    externalSerialization = live;
    onchange?.(live);
  }

  /** The editable element itself, for shell chrome that measures against it. */
  export function contentElement(): HTMLElement | null {
    return pmView()?.dom ?? null;
  }

  /**
   * Put the caret at viewport coordinates, for shell chrome sitting OUTSIDE
   * the editor whose slack reaches into it (the desktop tag bar). Returns
   * false when the point resolves to no text position.
   */
  export function placeCaretAtCoords(x: number, y: number): boolean {
    const view = pmView();
    if (!view) return false;
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) return false;
    const { doc, tr } = view.state;
    const selection = TextSelection.findFrom(doc.resolve(hit.pos), 1, true) ?? null;
    if (!selection) return false;
    view.dispatch(tr.setSelection(selection).scrollIntoView());
    return true;
  }

  /**
   * Re-derive everything that depends on the HOST's state rather than the
   * document — today the note universe, which decides which wikilinks render as
   * broken. Reached from the bridge's `setNotes`/`setImageBaseUrl`, so it must
   * not dispatch a transaction: that would make a host call look like a user
   * edit and normalize-save the note.
   *
   * Images are deliberately NOT rebuilt here. Their node views re-resolve
   * themselves through `onVaultImageSrcChange` (vaultImageView.ts), which is
   * also the only thing that works when a URL lands with no host call behind it
   * — a late `setImageBaseUrl`, or an async desktop `getImageUrl`.
   */
  export function refreshDecorations(): void {
    refreshWikilinkViews(pmView());
  }

  /**
   * Drops the undo/redo stack, keeping the document and the caret.
   *
   * CRITICAL — the host calls this on every `initialize`/`setContent`, i.e.
   * every note open (createFutoEditorApi.ts). Without it a Ctrl-Z after a note
   * switch replays the PREVIOUS note's steps into the current document and the
   * change that follows writes them to the current note's file. The first undo
   * after an open would also un-apply the load itself and leave the note empty.
   *
   * prosemirror-history exposes no clear command, so this hands its plugin the
   * initial state a fresh one would have, through the `historyKey` meta its own
   * undo/redo commands use (`applyTransaction` returns `meta.historyState`
   * verbatim). One empty transaction, nothing else touched.
   *
   * The obvious alternative — rebuilding the whole EditorState around the live
   * doc, which is what `replaceAll(md, true)` and CodeMirror's `swapEditorState`
   * do — is NOT usable here: `EditorState.create` builds a new plugin array, so
   * `view.updateState` sees changed plugins and destroys every plugin view. The
   * ⠿ block handle is parented outside the ProseMirror DOM by
   * @milkdown/plugin-block's BlockProvider, and that teardown detaches it for
   * good (BlockProvider only re-appends on a first `update()`, which it has
   * already had). Measured: the handle stopped existing after the first host
   * setContent.
   */
  export function resetHistory(): void {
    // Whatever this does to the stack, the stack is empty afterwards.
    historyBaselineDepth = 0;
    const view = pmView();
    if (!view) return;
    const { state } = view;
    if (undoDepth(state) === 0 && redoDepth(state) === 0) return;
    view.dispatch(state.tr.setMeta(HISTORY_KEY, { historyState: emptyHistoryState(state.schema) }));
  }

  /**
   * Loads `text` with explicit chunk options and returns Milkdown's
   * serialization of the resulting document, plus the plan that produced it.
   *
   * The ONLY consumer is the chunk-equivalence census
   * (`scripts/milkdown-chunk-census.mjs`), which proves the claim progressive
   * open rests on: a chunked parse of a note produces the same document as a
   * whole-document parse of it. That comparison cannot go through the bridge,
   * because the bridge deliberately never hands out a serialization of an
   * unedited note — that IS the load-echo guard. `src/editor-embed/main.ts`
   * installs it only for `editor.html?census`, a URL no shell ever loads.
   *
   * Read-only with respect to the host: it never posts a message and never
   * touches `hostMarkdown` beyond what a normal load does.
   */
  export function censusLoad(
    text: string,
    chunkOptions: MarkdownChunkOptions,
  ): { markdown: string | null; chunked: boolean; chunks: number; aborted: boolean } {
    const plan = planMarkdownChunks(text, chunkOptions);
    applyExternal(text, chunkOptions);
    progressive?.finishNow();
    return {
      markdown: readSerialized(),
      chunked: plan.chunked,
      chunks: plan.chunks.length,
      aborted: abortedToWholeDocument,
    };
  }

  /**
   * The live ProseMirror view, for the editor gauntlet's Milkdown adapter
   * (tests/editor-gauntlet/milkdownAdapter.ts) — the permanent regression
   * suite, which drives the SAME editor.html bytes the shells ship and so has
   * no other way in.
   *
   * It exists because the gauntlet's two hardest jobs need the document model,
   * not the DOM: placing a caret at an exact position across 31k foreign notes,
   * and timing one keystroke's SYNCHRONOUS cost against the 16 ms budget. A
   * DOM-selection approximation would measure a different thing and quietly
   * change what the budget means.
   *
   * Read-only by intent and not part of the futoBridge contract; no native
   * host calls it. `main.ts` is what puts it on `window`.
   */
  export function getProseMirrorView(): ProseView | null {
    return pmView();
  }

  export function exec(commandId: string): boolean {
    const action = EXEC[commandId];
    if (!action) {
      console.warn(`MilkdownEditor.exec: unsupported command '${commandId}'`);
      return false;
    }
    action();
    // A tap may change the block or a mark without moving the selection (e.g.
    // Bold mid-word), so selectionUpdated alone would miss it — and
    // markdownUpdated is 200ms-debounced, too slow for a toolbar highlight or
    // an Indent button to feel connected to the tap that caused it.
    emitCursorContext();
    emitFormatState();
    return true;
  }
</script>

<!-- The click handler is attached in onMount (see handleClick): it fires on
     ProseMirror-generated children, which the markup never sees. -->
<!-- `mobile-dnd` is the ONE mechanism that tells the stylesheet the ⠿ gutter
     handle does not exist for this instance, so the left padding can drop back
     to match the right (see the .ProseMirror padding rule below). It is driven
     by the SAME `useMobileBlockDnd` gate that swaps the plugin, so the gutter
     and the thing that needs the gutter can never disagree. -->
<!-- `--futo-checkbox-slot` is set here, from taskCheckbox.ts's own constant, so
     the tap-target size the widget promises and the list padding that makes
     room for it cannot drift apart. -->
<div
  class="futo-milkdown"
  class:mobile-dnd={useMobileBlockDnd}
  class:block-containment={skipOffscreenBlocks}
  style="--futo-checkbox-slot: {CHECKBOX_SIZE_PX}px"
  bind:this={container}
  oncompositionend={() => oncompositionend?.()}
>
  <!-- The streaming tail of a large note (progressiveLoad.ts). Absolutely
       positioned so it never enters the editor's layout, and rendered inside
       the container the same way the block-drag ghost is. `polite` rather than
       `assertive`: it is reassurance, not an interruption of typing. -->
  {#if streamingTail}
    <div class="milkdown-stream-tail" role="status" aria-live="polite">
      <span class="milkdown-stream-tail-dot" aria-hidden="true"></span>
      Loading the rest of this note…
    </div>
  {/if}
</div>

<style>
  .futo-milkdown {
    height: 100%;
    position: relative;
  }

  /*
   * `.milkdown` is Milkdown's own wrapper around the editable, and it is what
   * carries the editor's width. The desktop shell makes `.futo-milkdown` a FLEX
   * ROW (`app-shell.css` `.editor-container > div`, a CodeMirror-era rule), so
   * this wrapper is a flex ITEM: with the default `flex: 0 1 auto` its base
   * size is its CONTENT width, and an empty paragraph has no content, leaving
   * it exactly as wide as the editable's own padding — 72px of an 860px note
   * area, measured on a brand new note. Everything to the right of that strip
   * was outside the editor, so a press there placed no caret and typed nothing.
   * Growing to fill is the intent on both hosts; in the embed `.futo-milkdown`
   * is a plain block, where `flex` is simply inert.
   * → tests/p0-regressions.spec.ts, docs/spec/editor.md "Blank editor surface"
   */
  :global(.futo-milkdown .milkdown) {
    height: 100%;
    flex: 1 1 auto;
    /* An `auto` minimum would floor the item at its content's min-content
     * width, which a long unbroken word (a URL) can push past the note area. */
    min-width: 0;
  }

  /*
   * The editable is the scroller — in the EMBED. `editor.html` pins the page to
   * the web view and carries a definite height down to `.futo-milkdown`, so
   * `height: 100%` resolves, the editable overflows, and it keeps the
   * platform's overscroll affordance instead of chaining out to the host web
   * view (docs/spec/editor.md → "The editable element is the editor's own
   * scroll container"). The desktop shell scrolls differently; see the
   * `.notes-shell` rule right below.
   */
  :global(.futo-milkdown .ProseMirror) {
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    outline: none;
    /* Left padding is wider than the right: it is the gutter the block drag
     * handle floats in (see .milkdown-block-handle below), so it needs room
     * on a phone-width screen without eating into content width.
     *
     * The gutter must ALSO keep the handle clear of the leftmost 20pt of the
     * SCREEN. That strip belongs to UIKit's interactive-pop
     * UIScreenEdgePanGestureRecognizer (the swipe-back that pops the
     * NavigationStack), which delays touches begun inside it — a drag started
     * there reaches the WKWebView as NOTHING AT ALL: no pointerdown, no
     * touchstart, no moves. Measured on iPhone 17 Pro / iOS 26.5: an identical
     * synthetic drag delivers a full pointer stream at screen x >= 20 and zero
     * events at x <= 15, and a horizontal drag from x = 8 pops the stack.
     * At the old 34px gutter the 20px-wide handle sat at x 6..26 — its whole
     * left half, INCLUDING its centre, inside that dead strip, which is why
     * touch block-drag looked completely inert on iOS while working in
     * Chromium and in Mobile Safari with the very same bundle. 54px puts it at
     * x 26..46 (task items at 28..48). env() keeps that true in landscape,
     * where the notch inset already pushes the whole page in. */
    padding: 14px calc(18px + env(safe-area-inset-right)) max(40vh, 280px)
      calc(54px + env(safe-area-inset-left));
    color: var(--color-text, #0f0f0f);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    font-size: 17px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  /* THE APP SHELL OWNS ITS OWN SCROLL, so there the editable must not claim it.
   * `.note-body` is the desktop shell's scroller — the title and the tag bar
   * scroll away with the text, which is what the CodeMirror editor did too
   * (`.cm-scroller` was `overflow: visible` for exactly this reason) and what
   * `NoteWorkspace.svelte`'s `handleNoteBodyMouseDown` deselect zone is built
   * on. Nothing above `.futo-milkdown` there has a definite height, so the
   * `height: 100%` above resolves to auto and the editable grows to its whole
   * content height: a scroll container with NOTHING to scroll, covering the
   * entire note. `overscroll-behavior: contain` then means what it says — no
   * chaining — and a wheel anywhere over a long note moved nothing at all.
   * Making it a plain box hands the wheel back to `.note-body`.
   *
   * Scoped on `.notes-shell`, which `NotesShell.svelte` renders and the embed
   * never does, so this is "which shell mounted me", not a platform branch.
   *
   * `min-height`, NOT `height: auto` on its own. `overflow-y: visible` is what
   * hands the wheel back; the height only decides how far DOWN the editable
   * box reaches. A plain `auto` sizes it to its content, so on a note shorter
   * than the window it stopped well above the bottom of `.editor-container`
   * and the gap under it belonged to no one: `handleNoteBodyMouseDown` ignores
   * presses on a descendant, so a press there placed no caret, took no focus,
   * and did nothing at all. A BRAND NEW note is one empty line at the top, so
   * that dead gap was essentially the whole note — measured at 256px of 584px
   * on a 720px-tall window before this. `min-height: 100%` keeps the box
   * growing with its content while never ending above its container, which is
   * what docs/spec/editor.md's "Blank editor surface" requires.
   * → tests/editor-scroll.spec.ts, tests/p0-regressions.spec.ts */
  /* The desktop shell's body text starts where the title text starts. The
   * title column is 740px wide with 20px of padding; `.editor-container` is
   * 860px (desktop-shell.css: 60px past the title column each side, so the
   * space beside the text is reachable). 60 + 20 = 80px puts the first
   * character of a paragraph under the first character of the title, where
   * the mobile gutter's 54px above left the body 26px to the LEFT of it. The
   * ⠿ handle floats in this padding (floating-ui positions it), so the wider
   * gutter only gives it more room. → tests/p2-regressions.spec.ts */
  :global(.notes-shell.desktop-layout .futo-milkdown .ProseMirror) {
    padding-left: 80px;
  }

  :global(.notes-shell .futo-milkdown .ProseMirror) {
    height: auto;
    min-height: 100%;
    overflow-y: visible;
    overscroll-behavior: auto;
  }

  /* …and NONE of that applies without a handle. Under the long-press path both
   * native shells mount (useMobileBlockDnd -> .mobile-dnd) the block itself is
   * the handle, so there is nothing to keep clear of the back-swipe strip and
   * the 54px gutter is pure dead offset — the user's "gutter on the left is
   * still there, everything is still offset". Drop it back to the right side's
   * 18px. Nothing else depends on the 54px: `contentColumnX` measures the
   * column's centre, and the task checkbox sits inside its own list ITEM's
   * padding (taskCheckbox.ts, `.futo-task-checkbox` at `left: 0`), not in this
   * gutter, so it still lands clear of the edge at 18px. Three classes, so it
   * beats the base rule above regardless of source order. */
  :global(.futo-milkdown.mobile-dnd .ProseMirror) {
    padding-left: calc(18px + env(safe-area-inset-left));
  }

  :global(.futo-milkdown .ProseMirror > * + *) {
    margin-top: 0.75em;
  }

  /* The containment stylesheet (docs/plan/milkdown-transition.md §2/§5, issue
   * #106). Offscreen top-level blocks skip rendering work, so keystroke cost
   * stops scaling with document length: the 2026-08-27 perf probe measured
   * keystroke cost at 14k lines as 82% browser layout over the eager whole-doc
   * DOM without this rule, and under the 16ms p95 budget with it — which is
   * what lets the low-end Android reference phone hold the budget at real note
   * sizes (tests/android-editor-perf.mjs). `contain-intrinsic-size: auto 24px`
   * keeps the scrollbar stable: 24px approximates one unrendered line, and
   * `auto` remembers each block's real size once it has been rendered, so
   * scrolling back over visited content never jumps. Verified inside the real
   * editor chrome on all three shells (caret into skipped regions, scroll,
   * nested scroll containers) — the embed spec's containment test locks the
   * rule and the caret behavior.
   *
   * ENGINE-GATED by `.block-containment` (blockContainment.ts): Apple's WebKit
   * keeps a scrolled-in block's box but paints none of its text, so on iOS this
   * rule left holes in the middle of a note until some later scroll filled them
   * in. Chromium — Android's WebView, where the budgets above were measured,
   * and every desktop/web surface — still gets it. */
  :global(.futo-milkdown.block-containment .ProseMirror > *) {
    content-visibility: auto;
    contain-intrinsic-size: auto 24px;
  }

  :global(.futo-milkdown .ProseMirror h1),
  :global(.futo-milkdown .ProseMirror h2),
  :global(.futo-milkdown .ProseMirror h3),
  :global(.futo-milkdown .ProseMirror h4),
  :global(.futo-milkdown .ProseMirror h5),
  :global(.futo-milkdown .ProseMirror h6) {
    font-weight: 650;
    line-height: 1.25;
    margin-top: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror h1) {
    font-size: 1.7em;
  }
  :global(.futo-milkdown .ProseMirror h2) {
    font-size: 1.4em;
  }
  :global(.futo-milkdown .ProseMirror h3) {
    font-size: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror a) {
    color: var(--color-primary, #f26b1f);
    text-decoration: underline;
  }

  :global(.futo-milkdown .ProseMirror blockquote) {
    border-left: 3px solid var(--color-border, #e5e5e5);
    padding-left: 0.9em;
    color: var(--color-muted, #737373);
  }

  :global(.futo-milkdown .ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--color-surface, #f2f2f2);
    border-radius: 4px;
    padding: 0.1em 0.3em;
  }

  :global(.futo-milkdown .ProseMirror pre) {
    background: var(--color-surface, #f2f2f2);
    border-radius: 8px;
    padding: 0.8em;
    overflow-x: auto;
    white-space: pre;
  }

  :global(.futo-milkdown .ProseMirror pre code) {
    background: none;
    padding: 0;
  }

  /* YAML front matter (packages/editor/src/milkdown-compat/frontmatter.ts): an
   * atomic, non-editable block holding the note's metadata bytes verbatim.
   *
   * Shown rather than hidden, because a hidden block is one a Backspace from
   * the body can delete without the user ever seeing what went. Read as
   * metadata rather than as content: muted, monospace, a left rule, and no
   * caret — the `contenteditable="false"` in the node's own toDOM is what makes
   * it inert; this only has to LOOK inert so the difference is not a surprise.
   * `user-select: text` keeps it copyable, which reading metadata needs. */
  :global(.futo-milkdown .ProseMirror pre.futo-frontmatter) {
    background: var(--color-surface, #f2f2f2);
    border-left: 3px solid var(--color-border, #e5e5e5);
    border-radius: 0 6px 6px 0;
    padding: 0.7em 0.9em;
    margin: 0;
    color: var(--color-muted, #737373);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    line-height: 1.5;
    /* pre-wrap, not `pre`: a long metadata value wraps instead of forcing the
     * whole editor to scroll sideways (the code-block rule above can afford
     * `overflow-x: auto` because code lines are meant to stay unwrapped). */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: default;
    user-select: text;
    -webkit-user-select: text;
  }

  :global(.futo-milkdown .ProseMirror ul),
  :global(.futo-milkdown .ProseMirror ol) {
    padding-left: 1.4em;
  }

  /* Nesting indentation is CAPPED, because an unbounded one walks the note off
   * the screen — and a `padding-left` bigger than its container does not
   * overflow, it SHRINKS the content box to nothing, so there is not even
   * anything to scroll to.
   *
   * MEASURED, 402px viewport (iPhone 16/17 CSS pixels), 20-level bullet list,
   * at a flat 1.4em per level: level 13 computed to ZERO width and levels
   * 14-19 started past the right edge, with `scrollWidth === clientWidth`. The
   * note mounted all 20 items and the user saw a blank body — the reported
   * defect.
   *
   * The tiers: levels 1-4 keep the full step, so every ordinary list (the
   * common case is one to three) is pixel-identical to before; 5-8 taper to
   * half, still visibly nesting; from 9 down the indent stops growing
   * altogether. Total inset is therefore at most 8.4em (143px), leaving ~187px
   * of readable column on the narrowest phone at ANY depth. Past level 8 the
   * levels are no longer told apart by their left edge — a deliberate trade:
   * a 20-deep outline is pathological, and seeing the text is worth more than
   * counting the depth by eye.
   *
   * `:is(ul, ol)` chains rather than a JS-computed depth attribute: the depth
   * that matters is exactly "how many list ancestors", which the cascade
   * already knows. One `:is()` per level, so the chain LENGTH is the level it
   * applies from, and a longer chain is automatically more specific — the
   * tiers cannot be defeated by source order. No per-node decoration work on
   * the load or keystroke path (AGENTS.md M5).
   *
   * The flat tier keeps `list-style-position: outside` (the default): with no
   * padding for the marker to hang in, the bullet draws just left of the item's
   * content edge, in the flat column's own left margin — which reads correctly,
   * since every flat level shares that column. `inside` was tried first and is
   * wrong here: a list item's first child is a block `<p>`, so an inside marker
   * takes a line box of its OWN and every deep item renders as a lone bullet
   * with its text on the next line.
   *
   * What this does NOT reach: a nested TASK list also pays its own 28px
   * checkbox slot per level (`li[data-checked]` below), and that slot is a
   * minimum tap target, so unlike indentation it cannot taper. Capping the
   * list indent moves the depth at which a nested task list runs out of column
   * from 6 to 8; past that it still collapses. Overflowing instead is not a way
   * out either — a top-level block carries `contain: paint` from the
   * containment rule above in Chromium, which clips the overflow rather than
   * making it scrollable. Recorded as a Gap in docs/spec/editor.md; closing it
   * is a checkbox-layout decision, not an indentation one. */
  :global(.futo-milkdown .ProseMirror :is(ul, ol) :is(ul, ol) :is(ul, ol) :is(ul, ol) :is(ul, ol)) {
    padding-left: 0.7em;
  }

  :global(
    .futo-milkdown
      .ProseMirror
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
      :is(ul, ol)
  ) {
    padding-left: 0;
  }

  :global(.futo-milkdown .ProseMirror ul) {
    list-style: disc;
  }
  :global(.futo-milkdown .ProseMirror ol) {
    list-style: decimal;
  }

  :global(.futo-milkdown .ProseMirror li) {
    margin: 0.15em 0;
  }

  /* A task item gives its marker column to the checkbox, exactly as the
   * CodeMirror editor does (listDecorations.ts CHECKBOX_SLOT): the item's own
   * padding IS the slot, and the widget is positioned into it. That keeps the
   * box inside the item's box — no negative offsets reaching back into the
   * list's or the editor's padding, and so nothing that can drift into the
   * 20px screen-edge strip iOS reserves for the back swipe (see the
   * .ProseMirror padding comment).
   *
   * An ordered task list keeps its number: only the bullet is redundant once
   * there is a checkbox, so an ordered item pays the slot as its own padding,
   * after the number.
   *
   * A BULLET task list does not pay twice. The bullet is hidden, so the list's
   * marker column is empty, and the checkbox goes into that column instead of
   * into a second 28px of item padding beside it — which had task text start
   * 28px to the right of the bullet text above it (the reported "too much
   * margin-left"). The list's padding widens from 1.4em to the 28px slot so
   * the whole tap target still lies inside the list's own box, never in the
   * editor's gutter; `:has()` scopes it to lists that hold a task item, so a
   * plain bullet list is untouched. An engine without `:has()` (Chromium < 105)
   * falls back to the padded-item layout below, which is only wider.
   *
   * The extra 2px keeps the widget's left edge at x >= 20 on the native shells,
   * whose gutter is 18px: the leftmost 20pt of an iPhone screen belong to the
   * back-swipe gesture (see the .ProseMirror padding comment), and
   * tests/editor-embed-milkdown-parity.spec.ts holds that line. */
  :global(.futo-milkdown .ProseMirror li[data-checked]) {
    position: relative;
    padding-left: var(--futo-checkbox-slot);
  }

  :global(.futo-milkdown .ProseMirror ul > li[data-checked]) {
    list-style: none;
  }

  :global(.futo-milkdown .ProseMirror ul:has(> li[data-checked])) {
    padding-left: calc(var(--futo-checkbox-slot) + 2px);
  }

  :global(.futo-milkdown .ProseMirror ul:has(> li[data-checked]) > li[data-checked]) {
    padding-left: 0;
  }

  :global(
    .futo-milkdown .ProseMirror ul:has(> li[data-checked]) > li[data-checked] .futo-task-checkbox
  ) {
    left: calc(-1 * var(--futo-checkbox-slot));
  }

  /* The checkbox widget (taskCheckbox.ts). A fixed 28px in both axes that does
   * NOT scale with the editor font — a minimum tap target that shrinks with the
   * type size is not a minimum. Absolutely positioned, so its height can exceed
   * the line box without moving anything. */
  :global(.futo-milkdown .ProseMirror .futo-task-checkbox) {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--futo-checkbox-slot);
    height: var(--futo-checkbox-slot);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;
  }

  :global(.futo-milkdown .ProseMirror .futo-task-checkbox input) {
    width: 17px;
    height: 17px;
    margin: 0;
    cursor: pointer;
    accent-color: var(--color-primary, #f26b1f);
  }

  /* `#tag` decoration (tagDecorations.ts). Colour only — no box, no
   * background: the document holds a tag as plain text, so its glyphs must stay
   * on the text baseline at the text's own advance width or typing inside a tag
   * would shift the line. Same variable the CodeMirror editor's `.cm-md-tag`
   * uses. */
  :global(.futo-milkdown .ProseMirror .futo-tag) {
    color: var(--color-primary, #f26b1f);
  }

  :global(.futo-milkdown .ProseMirror hr) {
    border: none;
    border-top: 1px solid var(--color-border, #e5e5e5);
  }

  :global(.futo-milkdown .ProseMirror img) {
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
  }

  :global(.futo-milkdown .ProseMirror table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }

  :global(.futo-milkdown .ProseMirror th),
  :global(.futo-milkdown .ProseMirror td) {
    border: 1px solid var(--color-border, #e5e5e5);
    padding: 0.35em 0.6em;
    /* A freshly inserted table is all empty cells, and an empty cell is only
     * as wide as its padding (~34px): the caret placed in one is drawn hard
     * against the border and reads as "no caret at all". A floor of a few
     * characters shows both the caret and where the cell IS. A cell with text
     * grows past it as before. → tests/editor-embed-milkdown-interactive.spec.ts */
    min-width: 5em;
  }

  :global(.futo-milkdown .ProseMirror ::selection) {
    background: var(--color-selection, #ffe4d1);
  }

  /* Notion-style block drag handle. Positioned by Milkdown's
   * BlockProvider (floating-ui, `data-show` toggled by it); shown for
   * mouse hover natively, and for tap/selection via a synthetic pointermove
   * dispatched from this component (see nudgeBlockHandle). */
  :global(.futo-milkdown .milkdown-block-handle) {
    position: absolute;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    color: var(--color-muted, #737373);
    background: transparent;
    border-radius: 4px;
    cursor: grab;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.12s ease,
      background-color 0.12s ease;
    /* iOS/WKWebView native HTML5 drag on a plain draggable div: touch-action
     * stops the browser eating the long-press-drag gesture as a scroll, and
     * -webkit-user-drag is WebKit's own opt-in for element drag sources. */
    touch-action: none;
    -webkit-user-drag: element;
    user-select: none;
    -webkit-user-select: none;
    z-index: 5;
  }

  :global(.futo-milkdown .milkdown-block-handle[data-show='true']) {
    opacity: 1;
    pointer-events: auto;
  }

  :global(.futo-milkdown .milkdown-block-handle:active) {
    cursor: grabbing;
    background: var(--color-surface, #f2f2f2);
  }

  /* Drop indicator DOM comes from `.use(cursor)` (prosemirror-drop-indicator);
   * color/width are configured via dropCursorConfig in the script block. Used
   * by the desktop mouse/native-HTML5-drag path only — see the touch
   * fallback's own indicator below for why it does not share this one. */
  :global(.milkdown-drop-indicator) {
    border-radius: 2px;
  }

  /* Streaming-tail affordance. Pinned to the bottom of the editor rather than
     placed at the end of the document: the document end is thousands of lines
     away while the tail streams, so a marker there would be invisible — which
     is the opposite of an affordance. */
  .milkdown-stream-tail {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5em;
    padding: 0.4em 0.75em;
    /* env(safe-area-inset-bottom): the native shells run the editor edge to
       edge, so on a home-indicator phone a plain `bottom: 0` sits under it. */
    padding-bottom: calc(0.4em + env(safe-area-inset-bottom, 0px));
    pointer-events: none;
    font-size: 0.8125rem;
    color: var(--color-muted, #6b7280);
    background: linear-gradient(to top, var(--color-bg, #fff) 60%, transparent);
  }

  .milkdown-stream-tail-dot {
    width: 0.5em;
    height: 0.5em;
    border-radius: 50%;
    background: currentColor;
    animation: milkdown-stream-tail-pulse 1.2s ease-in-out infinite;
  }

  @keyframes milkdown-stream-tail-pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }

  /* A pulsing dot next to text that says the same thing is decoration, and
     `prefers-reduced-motion` users have asked for none of it. */
  @media (prefers-reduced-motion: reduce) {
    .milkdown-stream-tail-dot {
      animation: none;
      opacity: 0.6;
    }
  }

  /* The `/` block menu (slash/index.ts).
     `:global`, and body-mounted, because SlashProvider positions it against
     `document.body` in viewport coordinates — outside this component's subtree,
     so a scoped selector would never reach it, and outside every scroll
     container the shell nests, so nothing can clip it. Same shape and tokens as
     the wikilink suggestion popup (src/styles/markdown-links.css): they are the
     two caret popups in this editor and they should not look like two products.
     `data-show` is SlashProvider's own show/hide contract. */
  :global(.futo-slash-menu) {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 60;
    max-height: 280px;
    min-width: 200px;
    max-width: min(320px, calc(100vw - 16px));
    overflow-y: auto;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    font-family: var(--font-sans);
    font-size: 14px;
  }

  :global(.futo-slash-menu[data-show='false']) {
    display: none;
  }

  :global(.futo-slash-menu ul) {
    list-style: none;
    margin: 0;
    padding: 4px;
  }

  :global(.futo-slash-menu li) {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 8px;
    border-radius: 5px;
    cursor: pointer;
    color: var(--color-text);
  }

  :global(.futo-slash-menu li[aria-selected='true']) {
    background: rgba(var(--primary-rgb), 0.1);
  }

  :global(.futo-slash-menu-hint) {
    color: var(--color-muted);
    font-size: 12px;
  }
</style>
