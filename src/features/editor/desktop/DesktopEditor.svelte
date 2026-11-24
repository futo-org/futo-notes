<script lang="ts">
  /* The desktop note editor: view.ts on the engine, the note attached to the desktop
   * host (attachedNote.ts), which saves it and owns which note it is and what it saved.
   * The shell's note session follows it (`onnote`, `onsaved`, `savedSource`) and hears
   * of edits through `onchange`, coalesced off the keystroke path. */
  import { onDestroy, onMount } from 'svelte';
  import { _applyLocalMutation } from '$features/notes/notes.svelte';
  import { registerPuppetTextEditor } from '$app/puppet/puppetRegistry';
  import type { EditorLinkGesture } from '../editorLinkGesture';
  import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
  import {
    onVaultImageSrcChange,
    requestVaultImageUrl,
    resolveVaultImageSrc,
  } from '$features/images/vaultImageSrc';
  import {
    installVaultImageUrlResolver,
    uninstallVaultImageUrlResolver,
  } from '$features/images/vaultImageUrlResolver';
  import { AttachedNote, type AttachedNoteEvents } from './attachedNote';
  import { takeOffer } from './takeOffer';
  import { checkpointOrReload } from './checkpointOrReload';
  import { copyCodeToClipboard } from './copyCodeToClipboard';
  import FormatToolbar from './FormatToolbar.svelte';
  import TableGrips from './TableGrips.svelte';
  import type { TableGripsState } from './tableGrips';
  import type { ToolbarState } from './overlays';
  import {
    keepEditorState,
    readEditorFocusAndScroll,
    restoreKeptEditor,
    type EditorFocusAndScroll,
    type KeptEditor,
  } from './keptEditor';
  import { EditorView } from './view';
  import { createHeaderTagEdits, type HeaderTagEdits } from './headerTagEdits';
  import type { FindBarState } from './findInNote';
  import { showNoteIdChange } from './noteIdDelivery';
  import { keepPaneScroll } from './keepPaneScroll';
  import { opensBehind, resolvePressedLink } from './linkTarget';
  import { openPressedLink } from '$lib/platform/openExternalUrl';
  import './desktopEditor.css';
  import './desktopCodeBlocks.css';
  import './desktopSlashMenu.css';
  import './desktopFind.css';
  import './desktopImages.css';
  import './desktopCodeColours.css';
  import './desktopLinks.css';
  import './desktopTables.css';
  import './desktopTags.css';

  interface Props {
    /** The editor mounted, holding no note: the shell hands it the open one. This mount's
     *  own `openNote` names it: across a dev hot reload the bound object is the same. */
    onmount?: (mountedOpenNote: typeof openNote) => void;
    /** The draft was edited: at most every 200 ms while typing and at least every 1.5 s. */
    onchange?: () => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    /** The note the editor holds changed: a rename's final id, the conflict copy a save
     *  parked the draft in (`keepsOriginal`: the original keeps its bytes), or where a
     *  store workflow moved it (a move, a sync relocation). */
    onnote?: (fromId: string, toId: string, keepsOriginal: boolean) => void;
    /** A save wrote the note. */
    onsaved?: () => void;
    /** A click opened a note: a link's, or a wikilink's (the note it resolves to, else its
     *  target as written, which the shell creates). */
    onopenlink?: (noteId: string, gesture: EditorLinkGesture) => void;
    readonly?: boolean;
    /** The note's header tags, as the engine reads them; updated with `onchange`. */
    headerTags?: string[];
    /** The tag bar's edits of the open note; null with none open. */
    headerTagEdits?: HeaderTagEdits | null;
    /** What find's bar shows (findInNote.ts); the bar is the shell's. */
    onfindstate?: (state: FindBarState) => void;
  }

  interface HotReloadData {
    keptEditor?: KeptEditor;
  }

  let {
    onmount,
    onchange,
    onfocuschange,
    oncompositionend,
    onnote,
    onsaved,
    onopenlink,
    readonly = false,
    headerTags = $bindable([]),
    headerTagEdits = $bindable(null),
    onfindstate,
  }: Props = $props();

  const CHANGE_IDLE_MS = 200;
  const CHANGE_MAX_MS = 1500;

  let wrap: HTMLDivElement;
  let view: EditorView | null = null;
  /** The selection toolbar, as the view last placed it; null hides it. */
  let toolbar = $state<ToolbarState | null>(null);
  /** The table grips, as the view last placed them; null hides them. */
  let tableGrips = $state<TableGripsState | null>(null);
  let note: AttachedNote | null = null;
  let opening = 0;
  let switching: Promise<void> = Promise.resolve();
  /** A background save failed and none has succeeded since: its toast is up. */
  let saveFailing = false;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let firstUnreported = 0;
  /** Focus and scroll as a dev hot update found them; null outside one. */
  let beforeHotUpdate: EditorFocusAndScroll | null = null;
  /** What the editor this mount replaced kept, for this mount's first attach only. */
  let keptFromHotReload: KeptEditor | null = null;

  function reportChange(): void {
    clearTimeout(changeTimer);
    changeTimer = undefined;
    firstUnreported = 0;
    if (!note) return;
    headerTags = note.engine.headerTags();
    onchange?.();
  }

  function scheduleChange(): void {
    const now = performance.now();
    firstUnreported ||= now;
    clearTimeout(changeTimer);
    const wait = Math.min(CHANGE_IDLE_MS, firstUnreported + CHANGE_MAX_MS - now);
    changeTimer = setTimeout(reportChange, Math.max(0, wait));
  }

  /** A background save (the host's timer, a blur's checkpoint) failed: told once per
   *  streak of failures, which the next save that lands ends. */
  function saveFailed(error: unknown): void {
    console.warn('note save failed, retrying:', error);
    if (saveFailing) return;
    saveFailing = true;
    showGlobalToast({ path: 'notes.save.failedPending' });
  }

  function logReopenFailure(error: unknown): void {
    console.warn('re-opening the note on its merged text failed:', error);
  }

  const events: AttachedNoteEvents = {
    // The mutation first, in the same task: the note it names is in the notes the shell reads.
    landed: ({ mutation, fromId, toId, keepsOriginal, saved, recreated }) => {
      if (mutation) _applyLocalMutation(mutation);
      if (saved) saveFailing = false;
      if (toId !== fromId) onnote?.(fromId, toId, keepsOriginal);
      if (mutation) onsaved?.();
      if (recreated) showGlobalToast({ path: 'notes.save.openNoteDeletedKeepingDraft' });
    },
    // Not an edit of the user's: the tags refresh without `onchange`.
    offered: (source, engine) => {
      const adopted = view ? takeOffer({ view, engine, source }) : 'later';
      if (adopted === 'refused') void reload().catch(logReopenFailure);
      if (typeof adopted !== 'string') headerTags = engine.headerTags();
      return adopted;
    },
    saveFailed,
    deleted: () => view?.open(null),
  };

  function show(attached: AttachedNote | null): void {
    note = attached;
    headerTags = attached?.engine.headerTags() ?? [];
    headerTagEdits =
      attached && view ? createHeaderTagEdits(view, attached.engine, reportChange) : null;
    view?.open(attached?.engine ?? null);
  }

  function listenForHotUpdates(hot: NonNullable<ImportMeta['hot']>): () => void {
    const keep = (): void => {
      if (view) beforeHotUpdate = readEditorFocusAndScroll(view);
    };
    const forget = (): void => {
      beforeHotUpdate = null;
    };
    hot.on('vite:beforeUpdate', keep);
    hot.on('vite:afterUpdate', forget);
    return () => {
      hot.off('vite:beforeUpdate', keep);
      hot.off('vite:afterUpdate', forget);
    };
  }

  function keepForHotReload(data: HotReloadData): void {
    if (!view || !note || !beforeHotUpdate) return;
    data.keptEditor = keepEditorState(view, note.noteId, beforeHotUpdate);
  }

  function takeKeptEditor(data: HotReloadData): void {
    keptFromHotReload = data.keptEditor ?? null;
    delete data.keptEditor;
  }

  onMount(() => {
    view = new EditorView(wrap, {
      edited: (applied) => {
        note?.send(applied);
        scheduleChange();
      },
      focusChanged: (focused) => {
        // Leaving the editor saves now, besides the host's own timer.
        if (!focused) void checkpoint();
        onfocuschange?.(focused);
      },
      compositionEnded: () => {
        if (note?.offerWaiting) void checkpoint();
        oncompositionend?.();
      },
      toolbar: (state) => (toolbar = state),
      tableGrips: (state) => (tableGrips = state),
      copyCode: copyCodeToClipboard,
      findBar: (state) => onfindstate?.(state),
      images: {
        resolve: resolveVaultImageSrc,
        request: requestVaultImageUrl,
        onChange: onVaultImageSrcChange,
      },
      openLink: ({ link, gesture }) => {
        const target = note && resolvePressedLink(note.engine, note.noteId, link);
        if (target?.kind === 'note') onopenlink?.(target.noteId, gesture);
        if (target?.kind === 'external') {
          openPressedLink(target.url, opensBehind(gesture, navigator.platform.startsWith('Mac')));
        }
      },
      noteId: () => note?.noteId ?? null,
    });
    const ownsImageUrlResolver = installVaultImageUrlResolver();
    // So does the window losing focus, being hidden or minimized, or the page going away.
    const checkpointNow = () => void checkpoint();
    const checkpointWhenHidden = () => {
      if (document.visibilityState === 'hidden') checkpointNow();
    };
    window.addEventListener('blur', checkpointNow);
    window.addEventListener('pagehide', checkpointNow);
    document.addEventListener('visibilitychange', checkpointWhenHidden);
    const unregisterPuppet = registerPuppetTextEditor({
      view: () => (note ? view : null),
      note: () => note?.noteId ?? null,
      source: () => note?.engine.draftText() ?? null,
      idle,
    });
    const stopHotUpdates = import.meta.hot ? listenForHotUpdates(import.meta.hot) : null;
    if (import.meta.hot) takeKeptEditor(import.meta.hot.data);
    onmount?.(openNote);
    return () => {
      window.removeEventListener('blur', checkpointNow);
      window.removeEventListener('pagehide', checkpointNow);
      document.removeEventListener('visibilitychange', checkpointWhenHidden);
      unregisterPuppet();
      stopHotUpdates?.();
      if (ownsImageUrlResolver) uninstallVaultImageUrlResolver();
    };
  });

  onDestroy(() => {
    view?.codeHeader.writeEditedHeader();
    if (import.meta.hot) keepForHotReload(import.meta.hot.data);
    clearTimeout(changeTimer);
    view?.destroy();
    void note?.close(false).catch(() => {});
  });

  /* One switch: the host attaches the incoming note, then releases the outgoing one. Until
   * it answers the view shows nothing, so no keystroke reaches a note being released. */
  async function attach(
    next: (previous: AttachedNote | null) => Promise<AttachedNote | null>,
  ): Promise<void> {
    const previous = note;
    const kept = keptFromHotReload;
    keptFromHotReload = null;
    show(null);
    try {
      const attached = await next(previous);
      show(attached);
      if (import.meta.hot && kept && attached && view) restoreKeptEditor(view, attached, kept);
    } catch (error) {
      show(previous?.attached ? previous : null);
      throw error;
    }
  }

  /** Show `noteId`, releasing the note held before it: saved, or with `discardUnsaved`
   *  dropped. The same note is read back from disk; null shows no note. A rejection leaves
   *  the editor on the note it had. Calls run in order; one a later call supersedes does
   *  nothing. */
  export function openNote(noteId: string | null, discardUnsaved = false): Promise<void> {
    const version = ++opening;
    view?.codeHeader.writeEditedHeader();
    if (changeTimer !== undefined) reportChange();
    const run = switching.then(() =>
      version === opening
        ? attach(async (previous) => {
            if (noteId !== null) {
              return AttachedNote.open(previous, noteId, discardUnsaved, events);
            }
            await previous?.close(discardUnsaved);
            return null;
          })
        : undefined,
    );
    switching = run.catch(() => {});
    return run;
  }

  /** Re-read the open note from disk (an outside change adopted into a clean draft): the
   *  note the host holds once the switches asked for before it ran, named by the host. It
   *  supersedes none, or a note switch it overtook would resolve as if the editor held the
   *  new note. The pane keeps its scroll; the caret starts over, as does Undo. */
  export function reload(): Promise<void> {
    if (changeTimer !== undefined) reportChange();
    const run = switching.then(() =>
      note && view
        ? keepPaneScroll(view.dom, () =>
            attach((previous) => AttachedNote.reload(previous!, events)),
          )
        : undefined,
    );
    switching = run.catch(() => {});
    return run;
  }

  /** Take an outside change into the open, clean note (a verdict to adopt it): adopted in
   *  place through the host's checkpoint, keeping the caret and Undo, or read back from
   *  disk when no offer came (checkpointOrReload.ts). */
  export function takeOutsideChange(): Promise<void> {
    return switching.then(() => {
      const attached = note;
      if (!attached) return;
      return checkpointOrReload({
        revision: () => attached.engine.revision,
        checkpoint: () => attached.checkpoint(),
        composing: () => view?.isComposing() ?? false,
        reload,
      });
    });
  }

  export function getContent(): string | undefined {
    return note?.engine.draftText();
  }

  /** The note the host's attachment holds, as it last reported; null mid-switch. */
  export function heldNoteId(): string | null {
    return note?.noteId ?? null;
  }

  /** The source the open note held when its draft last matched it (attachedNote.ts). */
  export function savedSource(): string | undefined {
    return note?.savedSource;
  }

  /** Write the draft now. Rejects when the save fails; input carries on. */
  export async function save(): Promise<void> {
    if (!note) throw new Error('no note is open');
    await note.checkpoint();
  }

  /** Save the draft as `title` in its folder in one store workflow, the title's rename
   *  (docs/spec/editor/saving-and-rename.md); where it lands arrives through `onnote`. */
  export function rename(title: string): Promise<void> {
    return note ? note.rename(title) : Promise.reject(new Error('no note is open'));
  }

  /** Save now on a trigger (blur, hidden window, sleep, quit); input carries on if it fails. */
  export function checkpoint(): Promise<unknown> {
    if (!note) return Promise.resolve();
    return note.checkpoint().catch(saveFailed);
  }

  /** All edits acknowledged and written: Puppet's idle signal. */
  export function idle(): boolean {
    return (note?.idle ?? true) && changeTimer === undefined;
  }

  export function insertMarkdown(text: string): void {
    view?.insert(text);
  }

  export function focus(): void {
    view?.focus();
  }

  export function blur(): void {
    view?.dom.blur();
  }

  export function hasFocus(): boolean {
    return view?.hasFocus() ?? false;
  }

  export function isComposing(): boolean {
    return view?.isComposing() ?? false;
  }

  /** Find in the note (findInNote.ts): Ctrl/Cmd+F, the bar's query, steps (Enter, the arrows,
   *  Ctrl/Cmd+G), its close and its height. */
  export function openFind(): void {
    view?.find.open();
  }

  export function setFindQuery(query: string): void {
    view?.find.setQuery(query);
  }

  export function stepFind(direction: 1 | -1): void {
    view?.find.step(direction);
  }

  export function closeFind(): void {
    view?.find.close();
  }

  export function setFindBarHeight(pixels: number): void {
    view?.find.setBarHeight(pixels);
  }

  export function refreshDecorations(): void {
    const attached = note;
    void attached
      ?.refreshNoteIds()
      .then((change) => {
        if (change && view?.currentEngine() === attached.engine) showNoteIdChange(view, change);
      })
      .catch(() => {});
  }

  $effect(() => {
    view?.setReadonly(readonly);
  });
</script>

<div class="desktop-editor-wrap" bind:this={wrap}>
  <FormatToolbar
    {toolbar}
    ontoggle={(format) => view?.formatting.toggle(format)}
    onblock={(command) => view?.formatting.block(command)}
    onlink={() => view?.linkPrompt.open()}
  />
  <TableGrips
    grips={tableGrips}
    oncontrols={() => view?.tables.controls() ?? null}
    oncommand={(command) => view?.tables.run(command)}
    onpin={(pinned) => view?.tables.pinHoveredCell(pinned)}
  />
</div>
