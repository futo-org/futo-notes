<script lang="ts">
  import type { EditorView } from '@codemirror/view';

  import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
  import { extractHeaderTagBlock, isValidTagName, normalizeTagName } from '$lib/rules';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import { getAllTagNames } from '$features/tags/noteTags';
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
    placeCaretAtEnd: () => void;
  }

  interface Props {
    session: NoteSession;
    notes: NotePreview[];
    actions: ReturnType<typeof createCurrentNoteActions>;
    active: boolean;
    onopenlink: (title: string, event: MouseEvent) => void;
    onfocuschange?: (focused: boolean) => void;
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
    editorApi = $bindable(),
    noteBodyEl = $bindable(),
    titleEl = $bindable(),
  }: Props = $props();

  let editorFocused = $state(false);

  // ── Tag bar (header tag block editing) ──
  let addingTag = $state(false);
  let tagInputValue = $state('');
  let tagInputEl: HTMLInputElement | undefined = $state();

  const headerTags = $derived(extractHeaderTagBlock(session.content).tags);
  const currentTagNames = $derived(new Set(headerTags.map((tag) => tag.slice(1))));
  const normalizedQuery = $derived(normalizeTagName(tagInputValue));
  const vaultTagNames = $derived(getAllTagNames(notes));
  const tagSuggestions = $derived(
    vaultTagNames
      .filter((name) => !currentTagNames.has(name))
      .filter((name) => !normalizedQuery || name.includes(normalizedQuery))
      .slice(0, 8),
  );
  const showCreateTagRow = $derived(
    normalizedQuery.length > 0 &&
      isValidTagName(normalizedQuery) &&
      !vaultTagNames.includes(normalizedQuery) &&
      !currentTagNames.has(normalizedQuery),
  );

  function currentContent(): string {
    return editorApi?.getContent() ?? session.content;
  }

  // Rebuild the note with a new header tag block, preserving the body.
  function withHeaderTags(content: string, tags: string[]): string {
    const { endOffset } = extractHeaderTagBlock(content);
    const body = content.slice(endOffset).replace(/^\n+/, '');
    if (tags.length === 0) return body;
    const line = tags.join(' ');
    return body ? `${line}\n\n${body}` : `${line}\n`;
  }

  function commitTags(tags: string[]): void {
    const next = withHeaderTags(currentContent(), tags);
    editorApi?.setContent(next);
    session.debouncedSave(next);
  }

  function addTag(raw: string): void {
    const normalized = normalizeTagName(raw);
    if (!normalized || !isValidTagName(normalized)) {
      closeTagInput();
      return;
    }
    const tag = `#${normalized}`;
    const tags = extractHeaderTagBlock(currentContent()).tags;
    if (!tags.includes(tag)) commitTags([...tags, tag]);
    closeTagInput();
  }

  function removeTag(tag: string): void {
    const tags = extractHeaderTagBlock(currentContent()).tags;
    commitTags(tags.filter((existing) => existing !== tag));
  }

  function openTagInput(): void {
    addingTag = true;
    tagInputValue = '';
    requestAnimationFrame(() => tagInputEl?.focus());
  }

  function closeTagInput(): void {
    addingTag = false;
    tagInputValue = '';
  }

  function handleTagInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagInputValue);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeTagInput();
    }
  }

  function handleFocusChange(focused: boolean): void {
    editorFocused = focused;
    onfocuschange?.(focused);
  }
</script>

<div
  class="note-body"
  class:is-hidden={!active}
  bind:this={noteBodyEl}
  data-editor-focused={editorFocused ? '' : undefined}
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

  <div class="note-tag-bar">
    {#each headerTags as tag (tag)}
      <span class="tag-pill">
        <span class="tag-pill-name">{tag.slice(1)}</span>
        <button
          class="tag-pill-remove"
          aria-label="Remove tag {tag.slice(1)}"
          onclick={() => removeTag(tag)}>×</button
        >
      </span>
    {/each}
    {#if addingTag}
      <div class="tag-input-wrapper">
        <input
          class="tag-input"
          bind:this={tagInputEl}
          bind:value={tagInputValue}
          placeholder="tag"
          onkeydown={handleTagInputKeydown}
          onblur={closeTagInput}
        />
        {#if tagSuggestions.length > 0 || showCreateTagRow}
          <div class="tag-suggestions">
            {#each tagSuggestions as suggestion (suggestion)}
              <button
                class="tag-suggestion"
                onmousedown={(e) => {
                  e.preventDefault();
                  addTag(suggestion);
                }}>{suggestion}</button
              >
            {/each}
            {#if showCreateTagRow}
              <button
                class="tag-suggestion tag-suggestion-create"
                onmousedown={(e) => {
                  e.preventDefault();
                  addTag(normalizedQuery);
                }}>Create #{normalizedQuery}</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <button class="tag-add-btn" aria-label="Add tag" onclick={openTagInput}>+ Tag</button>
    {/if}
  </div>

  <div class="editor-container">
    <MarkdownEditor
      bind:this={editorApi}
      content={session.content}
      scrollParent={noteBodyEl ?? null}
      onchange={(content) => session.debouncedSave(content)}
      onfocuschange={handleFocusChange}
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
    onpick={(path) => actions.moveToFolder(path)}
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
