<script lang="ts">
  import { listenForFocusChange } from '$shared/dom/listenForFocusChange';
  import { isValidTagName, normalizeTagName } from '$lib/rules';
  import { getAllTagNames } from '$features/tags/noteTags';
  import type { NotePreview } from '$shared/types/note';
  import { localizedText } from '$shared/localization';
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import type { HeaderTagEdits } from './desktop/headerTagEdits';

  interface Props {
    /** The note's header tags (`#name`). */
    tags: string[];
    /** The engine's edits of the note these tags are in (the editor writes the tag block); null
     *  with no note open. A tag being typed belongs to the note it was started on. */
    edits: HeaderTagEdits | null;
    notes: NotePreview[];
    /** Whether the workspace around this bar is on screen: it stays mounted behind home. */
    active: boolean;
    /** Tags show but cannot be added or removed: the vault refuses writes. */
    readonly?: boolean;
    /** The field was left by key (Escape, or Enter with nothing typed): focus goes to the note. */
    onreturntonote?: () => void;
  }

  let { tags, edits, notes, active, readonly = false, onreturntonote }: Props = $props();

  let adding = $state(false);
  let inputValue = $state('');
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let selectedSuggestion = $state(-1);
  /** The note's edits the open field adds to. */
  let addingTo: HeaderTagEdits | null = null;

  let allTags = $derived(getAllTagNames(notes));
  let suggestions = $derived.by(() => {
    if (!adding || !inputValue.trim()) return [];
    const lower = normalizeTagName(inputValue);
    const currentLower = new Set(tags.map((t) => t.toLowerCase().replace(/^#/, '')));
    return allTags
      .filter((t) => t.toLowerCase().includes(lower) && !currentLower.has(t.toLowerCase()))
      .slice(0, 8);
  });

  let createName = $derived(normalizeTagName(inputValue));
  let isCreatable = $derived.by(() => {
    if (!adding || !createName) return false;
    if (!isValidTagName(createName)) return false;
    const lower = createName.toLowerCase();
    if (tags.some((t) => t.toLowerCase().replace(/^#/, '') === lower)) return false;
    if (allTags.some((t) => t.toLowerCase() === lower)) return false;
    return true;
  });

  // Another note opened (or none): the field it was typing in closes, adding nothing.
  $effect(() => {
    if (adding && edits !== addingTo) cancelAdding();
  });

  $effect(() =>
    registerPuppetVerbs(() =>
      // Hidden behind the home screen, these tags belong to no note the user can see; a
      // read-only vault draws them without the add and remove buttons.
      !active || readonly || !edits
        ? []
        : [
            puppetVerb('RemoveTag', { name: 'string' }, (args) => {
              const wanted = normalizeTagName(args.name as string).toLowerCase();
              const tag = tags.find((t) => t.toLowerCase().replace(/^#/, '') === wanted);
              if (!tag) return puppetRefusal(400, `this note has no tag ${wanted}`);
              removeTag(tag);
              return undefined;
            }),
            // The tag field's verbs only while it is open; `name` on the + types one in.
            ...(adding
              ? [
                  puppetVerb(
                    'AddTag',
                    { name: 'string' },
                    (args) => {
                      const name = normalizeTagName(args.name as string);
                      if (!isValidTagName(name))
                        return puppetRefusal(400, `not a valid tag name: ${name}`);
                      addTag(name);
                      return undefined;
                    },
                    { controls: ['editor.tags.inputPlaceholder'] },
                  ),
                  puppetVerb('CancelAddingTag', {}, cancelAdding),
                ]
              : [
                  puppetVerb('StartAddingTag', { name: 'string?' }, startAdding, {
                    controls: ['editor.tags.addTag'],
                    shortcuts: { name: [['AddTag', { name: '$' }]] },
                  }),
                ]),
          ],
    ),
  );

  function startAdding() {
    addingTo = edits;
    adding = true;
    inputValue = '';
    selectedSuggestion = -1;
    requestAnimationFrame(() => inputEl?.focus());
  }

  function cancelAdding() {
    addingTo = null;
    adding = false;
    inputValue = '';
    selectedSuggestion = -1;
  }

  /** Add the tag and keep the field, emptied, for the next one. */
  function addTag(name: string) {
    name = normalizeTagName(name);
    if (!isValidTagName(name)) return;

    const lower = name.toLowerCase();
    if (!tags.some((t) => t.toLowerCase().replace(/^#/, '') === lower)) addingTo?.add(name);
    inputValue = '';
    selectedSuggestion = -1;
  }

  function returnToNote() {
    cancelAdding();
    onreturntonote?.();
  }

  function removeTag(tag: string) {
    edits?.remove(tag);
  }

  function handleInputKeydown(e: KeyboardEvent) {
    const optionCount = suggestions.length + (isCreatable ? 1 : 0);
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (selectedSuggestion >= 0 && selectedSuggestion < suggestions.length) {
        addTag(suggestions[selectedSuggestion]);
      } else if (selectedSuggestion === suggestions.length && isCreatable) {
        addTag(createName);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      } else if (e.key === 'Enter') {
        returnToNote();
      }
    } else if (e.key === 'Escape') {
      returnToNote();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestion = Math.min(selectedSuggestion + 1, optionCount - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestion = Math.max(selectedSuggestion - 1, -1);
    }
  }
</script>

<div class="note-tag-bar">
  {#each tags as tag}
    <span class="tag-pill">
      <span class="tag-pill-name">{tag.replace(/^#/, '')}</span>
      {#if !readonly && edits}
        <button
          class="tag-pill-remove"
          aria-label={localizedText('editor.tags.removeAccessibilityLabel', { tagName: tag })}
          onclick={() => removeTag(tag)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      {/if}
    </span>
  {/each}

  {#if adding}
    <div class="tag-input-wrapper">
      <input
        type="text"
        class="tag-input"
        placeholder={localizedText('editor.tags.inputPlaceholder')}
        bind:value={inputValue}
        bind:this={inputEl}
        onkeydown={handleInputKeydown}
        {@attach (field) =>
          listenForFocusChange(field, (focused) => {
            if (!focused) setTimeout(cancelAdding, 150);
          })}
        maxlength={50}
      />
      {#if suggestions.length > 0 || isCreatable}
        <div class="tag-suggestions">
          {#each suggestions as suggestion, i}
            <button
              class="tag-suggestion"
              class:selected={i === selectedSuggestion}
              onmousedown={(e) => {
                e.preventDefault();
                addTag(suggestion);
              }}
            >
              {suggestion}
            </button>
          {/each}
          {#if isCreatable}
            <button
              class="tag-suggestion tag-suggestion-create"
              class:selected={selectedSuggestion === suggestions.length}
              onmousedown={(e) => {
                e.preventDefault();
                addTag(createName);
              }}
            >
              {localizedText('editor.tags.createTag', { tagName: createName })}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if !readonly && edits}
    <button
      class="tag-add-btn"
      aria-label={localizedText('editor.tags.addTag')}
      onclick={startAdding}>{localizedText('editor.tags.addTagShort')}</button
    >
  {/if}
</div>
