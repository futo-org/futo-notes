<script lang="ts">
  import type { SelectionRange } from '@codemirror/state';
  import type { EditorView } from '@codemirror/view';

  import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
  import NoteTagBar from '$features/editor/NoteTagBar.svelte';
  import { resolveBlankSpaceCaret } from '$features/editor/interactions/blankSpaceCaret';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import type { NotePreview } from '$shared/types/note';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';

  import type { createCurrentNoteActions } from '../createCurrentNoteActions.svelte';
  import NoteActionsMenu from './NoteActionsMenu.svelte';

  // The subset of the (frozen) editor's imperative API the shell drives.
  export interface EditorApi {
    setContent: (text: string, options?: { preserveSelection?: boolean }) => void;
    focus: () => void;
    blur: () => void;
    getContent: () => string | undefined;
    hasFocus: () => boolean;
    isComposing: () => boolean;
    getView: () => EditorView | null;
    refreshDecorations: () => void;
    placeCaretAtEnd: () => void;
    setCaret: (at: SelectionRange) => void;
  }

  interface Props {
    session: NoteSession;
    notes: NotePreview[];
    actions: ReturnType<typeof createCurrentNoteActions>;
    active: boolean;
    onopenlink: (title: string, event: MouseEvent) => void;
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

  // The CM DOM is only as tall and wide as the text, so blank space around it
  // reaches the editor through no one. → docs/spec/editor.md
  function handleBlankSpaceMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    // The tag bar's slack is note surface; its pills, buttons and input are not,
    // nor is the title row.
    if (event.target !== event.currentTarget && event.target !== tagBarEl) return;
    const view = editorApi?.getView();
    if (!view) return;

    const at = resolveBlankSpaceCaret(view, {
      x: event.clientX,
      y: event.clientY,
      topLimit: (tagBarEl ?? view.contentDOM).getBoundingClientRect().top,
    });
    if (at === null) return;

    event.preventDefault(); // don't blur the contenteditable
    editorApi?.focus();
    editorApi?.setCaret(at);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="note-body"
  class:is-hidden={!active}
  bind:this={noteBodyEl}
  data-editor-focused={editorFocused ? '' : undefined}
  onmousedown={handleBlankSpaceMouseDown}
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

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="editor-container" onmousedown={handleBlankSpaceMouseDown}>
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
