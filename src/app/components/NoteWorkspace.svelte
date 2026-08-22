<script lang="ts">
  import { EditorSelection, type SelectionRange } from '@codemirror/state';
  import type { EditorView } from '@codemirror/view';
  import type { SetEditorContentOptions } from '$features/editor/editorContentSync';
  import type { EditorLinkGesture } from '$features/editor/interactions/editorPointerInteractions';

  import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
  import NoteTagBar from '$features/editor/NoteTagBar.svelte';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import type { NotePreview } from '$shared/types/note';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';

  import type { createCurrentNoteActions } from '../createCurrentNoteActions.svelte';
  import NoteActionsMenu from './NoteActionsMenu.svelte';

  // The subset of the (frozen) editor's imperative API the shell drives.
  export interface EditorApi {
    setContent: (text: string, options?: SetEditorContentOptions) => void;
    openNote: (noteId: string | null, text: string) => void;
    retargetOpenNote: (fromId: string | null, toId: string) => void;
    forgetNoteHistory: (noteIds: readonly string[]) => void;
    focus: () => void;
    blur: () => void;
    getContent: () => string | undefined;
    hasFocus: () => boolean;
    isComposing: () => boolean;
    getView: () => EditorView | null;
    refreshDecorations: () => void;
    setCaret: (at: SelectionRange) => void;
  }

  interface Props {
    session: NoteSession;
    notes: NotePreview[];
    actions: ReturnType<typeof createCurrentNoteActions>;
    active: boolean;
    onopenlink: (title: string, gesture: EditorLinkGesture) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    editorApi?: EditorApi;
    noteBodyEl?: HTMLElement;
    titleEl?: HTMLTextAreaElement;
  }

  let {
    session,
    notes,
    actions,
    active,
    onopenlink,
    onfocuschange,
    oncompositionend,
    editorApi = $bindable(),
    noteBodyEl = $bindable(),
    titleEl = $bindable(),
  }: Props = $props();

  let editorFocused = $state(false);
  let tagBarEl: HTMLElement | undefined = $state(undefined);

  function handleFocusChange(focused: boolean): void {
    editorFocused = focused;
    onfocuschange?.(focused);
  }

  function isPlainPress(event: MouseEvent): boolean {
    if (event.button !== 0) return false;
    return !(event.shiftKey || event.altKey || event.metaKey || event.ctrlKey);
  }

  // No coords means a note that is nothing but its hidden tag block.
  function canPlaceCaretAt(view: EditorView, at: number): boolean {
    return view.coordsAtPos(at) !== null;
  }

  // The side chrome is outside the editor surface and owns deselection. → docs/spec/editor.md
  function handleNoteBodyMouseDown(event: MouseEvent): void {
    if (!isPlainPress(event)) return;
    if (event.target === tagBarEl && reachFromTagBar(event)) return;
    // Only the body's own slack — descendants keep their clicks.
    if (event.target !== event.currentTarget && event.target !== tagBarEl) return;

    // Cancels WebKit's native margin drag into the editor; the manual blur also
    // commits a pending title rename, which preventDefault swallows.
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  // The bar sits above the editor, so its slack reaches down into the first line.
  function reachFromTagBar(event: MouseEvent): boolean {
    const view = editorApi?.getView();
    if (!view) return false;
    const top = view.contentDOM.getBoundingClientRect().top;
    const at = view.posAtCoords({ x: event.clientX, y: top + 1 }, false);
    if (!canPlaceCaretAt(view, at)) return false;

    event.preventDefault();
    editorApi?.focus();
    editorApi?.setCaret(EditorSelection.cursor(at));
    return true;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="note-body"
  class:is-hidden={!active}
  bind:this={noteBodyEl}
  data-editor-focused={editorFocused ? '' : undefined}
  onmousedown={handleNoteBodyMouseDown}
>
  <div class="note-title-row">
    <textarea
      class="title-input"
      bind:this={titleEl}
      value={session.title}
      rows="1"
      spellcheck="false"
      placeholder="Untitled"
      oninput={session.handleTitleInput}
      onkeydown={session.handleTitleKeydown}
      onblur={session.handleTitleBlur}
      onfocus={session.handleTitleFocus}
      onpointerdown={session.handleTitlePointerDown}></textarea>
    {#if session.titleWarning}
      <div class="title-warning">{session.titleWarning}</div>
    {/if}
  </div>

  <NoteTagBar
    bind:element={tagBarEl}
    content={session.content}
    getEditorView={() => editorApi?.getView() ?? null}
    {notes}
  />

  <div class="editor-container">
    <MarkdownEditor
      bind:this={editorApi}
      content={session.content}
      scrollParent={noteBodyEl ?? null}
      onchange={(content) => session.debouncedSave(content)}
      onfocuschange={handleFocusChange}
      {oncompositionend}
      {onopenlink}
    />
  </div>
</div>

{#if active}
  <NoteActionsMenu
    open={actions.menuOpen}
    ontoggle={actions.toggleMenu}
    onclose={actions.closeMenu}
    ongraphview={actions.graphView}
    oncopypath={actions.copyFilePath}
    onmove={actions.openMovePicker}
    ondelete={actions.deleteCurrentNote}
  />
{/if}

{#if active && actions.movePickerOpen}
  <FolderPickerModal
    {notes}
    onpick={(path) => void actions.moveToFolder(path)}
    oncancel={actions.closeMovePicker}
  />
{/if}

<style>
  .note-body.is-hidden {
    display: none;
  }

  .title-input {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    resize: none;
    overflow: hidden;
    font-family: var(--font-serif);
    font-size: 28px;
    font-weight: 700;
    line-height: 1.25;
    color: var(--color-text);
    padding: 0;
  }

  .title-input::placeholder {
    color: var(--color-border);
  }

  .title-warning {
    margin-top: 4px;
    font-size: 12px;
    color: var(--color-danger);
  }
</style>
