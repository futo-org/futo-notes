<script lang="ts">
  import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
  import NoteTagBar from '$features/editor/NoteTagBar.svelte';
  import ForYouPage from '$features/notes/ForYouPage.svelte';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import type { NotePreview } from '$shared/types/note';

  interface Props {
    noteId: string | null;
    notes: NotePreview[];
    session: NoteSession;
    editorFocused: boolean;
    editor?: ReturnType<typeof MarkdownEditor> | null;
    noteBody?: HTMLElement | undefined;
    titleTextarea?: HTMLTextAreaElement | undefined;
    oneditorfocuschange: (focused: boolean) => void;
    onbodyfocusin: (event: FocusEvent) => void;
    onopenwikilink: (title: string, event: MouseEvent) => void;
    onnavigate: (id: string) => void;
  }

  let {
    noteId,
    notes,
    session,
    editorFocused,
    editor = $bindable(null),
    noteBody = $bindable(undefined),
    titleTextarea = $bindable(undefined),
    oneditorfocuschange,
    onbodyfocusin,
    onopenwikilink,
    onnavigate,
  }: Props = $props();

  function handleBodyClick(event: MouseEvent): void {
    if (!editor) return;
    const target = event.target as HTMLElement;
    if (target.closest('.cm-editor')) return;
    if (target.closest('.note-title-row, .note-tag-bar, a, button, input, textarea, select')) {
      return;
    }

    const editorRect = editor.getView()?.dom.getBoundingClientRect();
    if (editorRect && event.clientY > editorRect.bottom) editor.placeCaretAtEnd();
    editor.focus();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="note-body"
  data-editor-focused={editorFocused ? '' : undefined}
  bind:this={noteBody}
  onclick={handleBodyClick}
  onfocusin={onbodyfocusin}
>
  {#if noteId}
    <div class="note-title-row">
      <textarea
        rows="1"
        class="title-input w-full border-none bg-transparent p-0 focus:outline-none"
        style="font-family: var(--font-serif); font-size: 30px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; color: var(--color-text); resize: none; overflow: hidden; min-height: 36px;"
        placeholder="Untitled"
        bind:value={session.title}
        oninput={session.handleTitleInput}
        onkeydown={session.handleTitleKeydown}
        onfocus={session.handleTitleFocus}
        onpointerdown={session.handleTitlePointerDown}
        maxlength={200}
        enterkeyhint="done"
        bind:this={titleTextarea}></textarea>
      {#if session.titleWarning}
        <div class="text-xs pt-0.5" style="color: var(--color-danger)">
          {session.titleWarning}
        </div>
      {/if}
    </div>
    <NoteTagBar content={session.content} getEditorView={() => editor?.getView() ?? null} {notes} />
    <div class="editor-container">
      <MarkdownEditor
        bind:this={editor}
        content={session.content}
        onchange={session.debouncedSave}
        onfocuschange={oneditorfocuschange}
        scrollParent={noteBody ?? null}
        onopenlink={onopenwikilink}
      />
    </div>
  {:else}
    <ForYouPage {notes} {onnavigate} />
  {/if}
</div>
