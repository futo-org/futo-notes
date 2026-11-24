<script lang="ts">
  import { listenForFocusChange } from '$shared/dom/listenForFocusChange';
  import DesktopEditor from '$features/editor/desktop/DesktopEditor.svelte';
  import FindPanel from '$features/editor/desktop/FindPanel.svelte';
  import type { FindBarState } from '$features/editor/desktop/findInNote';
  import { desktopEditorDebugEntries } from '$features/editor/desktop/debugToggles.svelte';
  import NoteTagBar from '$features/editor/NoteTagBar.svelte';
  import type { HeaderTagEdits } from '$features/editor/desktop/headerTagEdits';
  import type { NoteSession } from '$features/notes/noteSession.svelte';
  import type { NotePreview } from '$shared/types/note';
  import type { EditorLinkGesture } from '$features/editor/editorLinkGesture';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';
  import { vaultAvailability } from '$features/storage/vaultAvailability.svelte';
  import { localizedText } from '$shared/localization';

  import type { createCurrentNoteActions } from '../createCurrentNoteActions.svelte';
  import DropdownMenu, { type DropdownMenuEntry } from '$shared/dialogs/DropdownMenu.svelte';
  import { ANSWER_PARAM, throughConfirmation } from '$app/puppet/puppetConfirm';
  import {
    puppetRefusal,
    puppetVerb,
    registerPuppetVerbs,
    SHORTCUT_STEPS,
  } from '$app/puppet/puppetRegistry';

  // The subset of the editor's imperative API the shell drives.
  export type EditorApi = Pick<
    ReturnType<typeof DesktopEditor>,
    | 'openNote'
    | 'reload'
    | 'takeOutsideChange'
    | 'getContent'
    | 'heldNoteId'
    | 'savedSource'
    | 'save'
    | 'rename'
    | 'checkpoint'
    | 'idle'
    | 'insertMarkdown'
    | 'focus'
    | 'blur'
    | 'hasFocus'
    | 'isComposing'
    | 'refreshDecorations'
    | 'openFind'
    | 'stepFind'
    | 'setFindQuery'
    | 'setFindBarHeight'
    | 'closeFind'
  >;

  interface Props {
    session: NoteSession;
    notes: NotePreview[];
    actions: ReturnType<typeof createCurrentNoteActions>;
    active: boolean;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    /** A click in the note opened a wikilink (DesktopEditor `onopenlink`). */
    onopenlink?: (noteId: string, gesture: EditorLinkGesture) => void;
    /** The editor mounted, holding no note (again after a dev hot reload of it); its own
     *  `openNote` names that mount. */
    oneditormount?: (mountedOpenNote: EditorApi['openNote']) => void;
    editorApi?: EditorApi;
    noteBodyEl?: HTMLElement;
    titleEl?: HTMLTextAreaElement;
  }

  let {
    session,
    notes,
    actions,
    active,
    onfocuschange,
    oncompositionend,
    onopenlink,
    oneditormount,
    editorApi = $bindable(),
    noteBodyEl = $bindable(),
    titleEl = $bindable(),
  }: Props = $props();

  let headerTags = $state<string[]>([]);
  let headerTagEdits = $state<HeaderTagEdits | null>(null);

  // Move and Delete write to the vault; an unusable one disables them. A development build
  // adds the desktop editor's debug toggles.
  const noteMenuEntries: DropdownMenuEntry[] = $derived([
    { label: { path: 'notes.actions.copyFilePath' }, onclick: () => void actions.copyFilePath() },
    {
      label: { path: 'notes.actions.moveToFolder' },
      onclick: () => actions.openMovePicker(),
      testId: 'note-menu-move',
      disabled: vaultAvailability.unavailable,
    },
    {
      label: { path: 'notes.actions.deleteNote' },
      onclick: () => void actions.deleteCurrentNote(),
      destructive: true,
      disabled: vaultAvailability.unavailable,
    },
    ...(import.meta.env.DEV ? desktopEditorDebugEntries() : []),
  ]);

  let editorFocused = $state(false);
  /* What find's bar shows, as the editor's find reports it. The bar is the shell's chrome: it
   * spans the whole note pane. */
  let find: FindBarState = $state({
    open: false,
    query: '',
    label: '',
    hasMatches: false,
    focusToken: 0,
  });

  // The title field and the note's overflow menu; the picker, tag bar and
  // editor register their own verbs. "Current" because the sidebar's DeleteNote
  // and MoveNote name a note; these act on the open one, as the menu does.
  $effect(() =>
    registerPuppetVerbs(() =>
      // The workspace stays mounted behind the home screen, where none of its chrome is on
      // screen: `active` is the same flag the markup uses, so the menu says what the user
      // can reach rather than what happens to be mounted.
      !active
        ? []
        : [
            // Typing a title and moving on: the blur handler flushes the debounced save, so
            // the verb does too, and its receipt settles once the rename has landed.
            puppetVerb(
              'SetTitle',
              { title: 'string' },
              (args) => {
                if (vaultAvailability.unavailable) {
                  return puppetRefusal(409, 'the vault is unavailable, so the title is read-only');
                }
                if (!session.setTitle(args.title as string)) {
                  return puppetRefusal(409, 'no title field is mounted');
                }
                return session.flushSave();
              },
              { controls: ['notes.untitledPlaceholder'] },
            ),
            puppetVerb('ToggleNoteActionsMenu', {}, actions.toggleMenu),
            // The menu's items, while it is open. A note still being created has no file yet, so
            // nothing that acts on the file is on offer: `actions` lists what can succeed now.
            ...(session.originalId === null || !actions.menuOpen
              ? []
              : [
                  puppetVerb('CopyCurrentNotePath', {}, actions.copyFilePath, {
                    controls: ['notes.actions.copyFilePath'],
                  }),
                  // Move and Delete are disabled in the menu while the vault is unusable.
                  ...(vaultAvailability.unavailable
                    ? []
                    : [
                        puppetVerb(
                          'MoveCurrentNoteToFolder',
                          { targetPath: 'string?' },
                          actions.openMovePicker,
                          {
                            controls: ['notes.actions.moveToFolder'],
                            shortcuts: { targetPath: SHORTCUT_STEPS.targetPath },
                          },
                        ),
                        puppetVerb(
                          'DeleteCurrentNote',
                          ANSWER_PARAM,
                          () => throughConfirmation(actions.deleteCurrentNote),
                          { controls: ['notes.actions.deleteNote'] },
                        ),
                      ]),
                ]),
          ],
    ),
  );

  function handleFocusChange(focused: boolean): void {
    editorFocused = focused;
    onfocuschange?.(focused);
  }
</script>

<div
  class="note-body"
  dir="ltr"
  class:is-hidden={!active}
  bind:this={noteBodyEl}
  data-editor-focused={editorFocused ? '' : undefined}
>
  <div class="note-title-row">
    <textarea
      class="title-input"
      bind:this={titleEl}
      value={session.fieldTitle}
      rows="1"
      spellcheck="false"
      placeholder={localizedText('notes.untitledPlaceholder')}
      readonly={vaultAvailability.unavailable}
      oninput={session.handleTitleInput}
      onkeydown={session.handleTitleKeydown}
      {@attach (title) =>
        listenForFocusChange(title, (focused, event) =>
          focused ? session.handleTitleFocus(event) : session.handleTitleBlur(),
        )}
      onpointerdown={session.handleTitlePointerDown}></textarea>
    {#if session.titleWarning}
      <div class="title-warning">{session.titleWarning}</div>
    {/if}
  </div>

  <NoteTagBar
    {active}
    tags={headerTags}
    edits={headerTagEdits}
    {notes}
    readonly={vaultAvailability.unavailable}
    onreturntonote={() => editorApi?.focus()}
  />

  <div class="editor-container">
    <DesktopEditor
      bind:this={editorApi}
      bind:headerTags
      bind:headerTagEdits
      onmount={oneditormount}
      onchange={session.editorEdited}
      onfocuschange={handleFocusChange}
      {oncompositionend}
      onnote={session.followEditorNote}
      onsaved={session.editorSaved}
      onfindstate={(state) => (find = state)}
      {onopenlink}
      readonly={vaultAvailability.unavailable}
    />
  </div>

  {#if find.open}
    <FindPanel
      query={find.query}
      label={find.label}
      hasMatches={find.hasMatches}
      focusToken={find.focusToken}
      onquery={(value) => editorApi?.setFindQuery(value)}
      onstep={(direction) => editorApi?.stepFind(direction)}
      onheight={(px) => editorApi?.setFindBarHeight(px)}
      onclose={() => editorApi?.closeFind()}
    />
  {/if}
</div>

{#if active}
  <div class="note-menu-anchor">
    <DropdownMenu
      open={actions.menuOpen}
      ontoggle={actions.toggleMenu}
      onclose={actions.closeMenu}
      entries={noteMenuEntries}
      label={localizedText('notes.actions.optionsAccessibilityLabel')}
      toggleClass="note-menu-toggle"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="12" cy="19" r="1.6" />
      </svg>
    </DropdownMenu>
  </div>
{/if}

{#if active && actions.movePickerOpen}
  <FolderPickerModal {notes} onpick={actions.moveToFolder} oncancel={actions.closeMovePicker} />
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
