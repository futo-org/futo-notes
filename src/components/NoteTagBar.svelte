<script lang="ts">
  import type { EditorView } from '@codemirror/view';
  import { extractHeaderTagBlock, isValidTagName } from '@futo-notes/shared';
  import { getAllTagNames } from '$lib/tags';
  import type { NotePreview } from '../types';

  interface Props {
    content: string;
    getEditorView: () => EditorView | null;
    notes: NotePreview[];
  }

  let { content, getEditorView, notes }: Props = $props();

  let adding = $state(false);
  let inputValue = $state('');
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let selectedSuggestion = $state(-1);

  // Extract header tag block from current content
  let headerBlock = $derived(extractHeaderTagBlock(content));
  let tags = $derived(headerBlock.tags);

  // Autocomplete suggestions
  let allTags = $derived(getAllTagNames(notes));
  let suggestions = $derived.by(() => {
    if (!adding || !inputValue.trim()) return [];
    const lower = inputValue.toLowerCase();
    const currentLower = new Set(tags.map(t => t.toLowerCase().replace(/^#/, '')));
    return allTags
      .filter(t => t.toLowerCase().includes(lower) && !currentLower.has(t.toLowerCase()))
      .slice(0, 8);
  });

  // "Create #foo" row appears when the typed value is a valid tag name
  // that isn't already attached and isn't an exact (case-insensitive)
  // match of an existing tag — so the user has a visible way to act.
  let createName = $derived(inputValue.trim().replace(/^#/, ''));
  let isCreatable = $derived.by(() => {
    if (!adding || !createName) return false;
    if (!isValidTagName(createName)) return false;
    const lower = createName.toLowerCase();
    if (tags.some(t => t.toLowerCase().replace(/^#/, '') === lower)) return false;
    if (allTags.some(t => t.toLowerCase() === lower)) return false;
    return true;
  });

  function startAdding() {
    adding = true;
    inputValue = '';
    selectedSuggestion = -1;
    // Focus input after it renders
    requestAnimationFrame(() => inputEl?.focus());
  }

  function cancelAdding() {
    adding = false;
    inputValue = '';
    selectedSuggestion = -1;
  }

  function addTag(name: string) {
    name = name.trim().replace(/^#/, '');
    if (!isValidTagName(name)) return;

    // Check for duplicate (case-insensitive)
    const lower = name.toLowerCase();
    if (tags.some(t => t.toLowerCase().replace(/^#/, '') === lower)) {
      cancelAdding();
      return;
    }

    const view = getEditorView();
    if (!view) return;

    const tagText = `#${name}`;
    const doc = view.state.doc.toString();
    const { tags: existingTags, endOffset } = extractHeaderTagBlock(doc);

    let insert: string;
    let pos: number;

    if (existingTags.length === 0) {
      // No header block yet — prepend tag + blank line
      insert = `${tagText}\n\n`;
      pos = 0;
    } else {
      // Find the end of the last non-empty tag line (before the trailing blank line)
      const lines = doc.split('\n');
      let offset = 0;
      let lastTagLineEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineEnd = offset + lines[i].length;
        if (offset >= endOffset) break;
        if (lines[i].trim() !== '') {
          lastTagLineEnd = lineEnd;
        }
        offset = lineEnd + 1; // +1 for \n
      }
      insert = ` ${tagText}`;
      pos = lastTagLineEnd;
    }

    view.dispatch({
      changes: { from: pos, to: pos, insert },
    });

    cancelAdding();
  }

  function removeTag(tag: string) {
    const view = getEditorView();
    if (!view) return;

    const doc = view.state.doc.toString();
    const { endOffset } = extractHeaderTagBlock(doc);
    const headerText = doc.slice(0, endOffset);

    // Find the tag in the header block
    const tagLower = tag.toLowerCase();
    const tagRegex = new RegExp(`(\\s*)#${escapeRegex(tag.replace(/^#/, ''))}`, 'gi');
    let match: RegExpExecArray | null;
    let removeFrom = -1;
    let removeTo = -1;

    while ((match = tagRegex.exec(headerText)) !== null) {
      const matchTag = match[0].replace(/^\s*/, '');
      if (matchTag.toLowerCase() === tagLower) {
        removeFrom = match.index;
        removeTo = match.index + match[0].length;
        break;
      }
    }

    if (removeFrom === -1) return;

    // Check if removing this tag leaves the header block empty
    const remaining = (headerText.slice(0, removeFrom) + headerText.slice(removeTo)).trim();
    const hasTagsLeft = /^#[a-zA-Z]/.test(remaining.split('\n').find(l => l.trim())?.trim() ?? '');

    if (!hasTagsLeft) {
      // Remove entire header block
      view.dispatch({
        changes: { from: 0, to: endOffset },
      });
    } else {
      // Remove just this tag (and clean up extra whitespace)
      let from = removeFrom;
      let to = removeTo;

      // If tag is at the start of a line, also remove trailing space
      if (from === 0 || doc[from - 1] === '\n') {
        if (to < doc.length && doc[to] === ' ') to++;
      }
      // If tag has leading space, include it
      else if (from > 0 && doc[from] === ' ') {
        // leading space is part of the match already
      }

      view.dispatch({
        changes: { from, to },
      });
    }
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
      }
    } else if (e.key === 'Escape') {
      cancelAdding();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestion = Math.min(selectedSuggestion + 1, optionCount - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestion = Math.max(selectedSuggestion - 1, -1);
    }
  }

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
</script>

<div class="note-tag-bar">
  {#each [...tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) as tag}
    <span class="tag-pill">
      <span class="tag-pill-name">{tag.replace(/^#/, '')}</span>
      <button
        class="tag-pill-remove"
        aria-label="Remove tag {tag}"
        onclick={() => removeTag(tag)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </span>
  {/each}

  {#if adding}
    <div class="tag-input-wrapper">
      <input
        type="text"
        class="tag-input"
        placeholder="tag name"
        bind:value={inputValue}
        bind:this={inputEl}
        onkeydown={handleInputKeydown}
        onblur={() => { setTimeout(cancelAdding, 150); }}
        maxlength={50}
      />
      {#if suggestions.length > 0 || isCreatable}
        <div class="tag-suggestions">
          {#each suggestions as suggestion, i}
            <button
              class="tag-suggestion"
              class:selected={i === selectedSuggestion}
              onmousedown={(e) => { e.preventDefault(); addTag(suggestion); }}
            >
              {suggestion}
            </button>
          {/each}
          {#if isCreatable}
            <button
              class="tag-suggestion tag-suggestion-create"
              class:selected={selectedSuggestion === suggestions.length}
              onmousedown={(e) => { e.preventDefault(); addTag(createName); }}
            >
              + Create #{createName}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <button class="tag-add-btn" onclick={startAdding}>+ Tag</button>
  {/if}
</div>
