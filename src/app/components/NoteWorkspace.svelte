<script lang="ts">
  import type { EditorLinkGesture } from '$features/editor/editorLinkGesture';

  import MilkdownEditor from '$features/editor/milkdown/MilkdownEditor.svelte';
  import NoteTagBar from '$features/editor/NoteTagBar.svelte';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import type { NotePreview } from '$shared/types/note';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';
  import { openExternalUrl } from '$lib/platform/openExternalUrl';
  import { localizedText } from '$shared/localization';

  import type { createCurrentNoteActions } from '../createCurrentNoteActions.svelte';
  import NoteActionsMenu from './NoteActionsMenu.svelte';

  // The subset of the editor's imperative API the shell drives.
  export interface EditorApi {
    setContent: (text: string) => void;
    openNote: (text: string) => void;
    applyEdit: (markdown: string) => void;
    insertMarkdown: (text: string) => void;
    focus: () => void;
    blur: () => void;
    getContent: () => string | undefined;
    hasFocus: () => boolean;
    isComposing: () => boolean;
    refreshDecorations: () => void;
    contentElement: () => HTMLElement | null;
    placeCaretAtCoords: (x: number, y: number) => boolean;
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
    const contentEl = editorApi?.contentElement();
    if (!contentEl) return false;
    const top = contentEl.getBoundingClientRect().top;

    event.preventDefault();
    editorApi?.focus();
    return editorApi?.placeCaretAtCoords(event.clientX, top + 1) ?? false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="note-body"
  dir="ltr"
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
      placeholder={localizedText('notes.untitledPlaceholder')}
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
    readMarkdown={() => editorApi?.getContent()}
    writeMarkdown={(markdown) => editorApi?.applyEdit(markdown)}
    {notes}
  />

  <div class="editor-container">
    <MilkdownEditor
      bind:this={editorApi}
      content={session.content}
      onchange={(content) => session.debouncedSave(content)}
      onfocuschange={handleFocusChange}
      {oncompositionend}
      {onopenlink}
      onopenurl={openExternalUrl}
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
