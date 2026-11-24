<script lang="ts">
  /* The selection toolbar: Heading 1, 2 and 3 and Quote (blockButtons.ts), then Bold, Italic,
   * Strikethrough and Code, for a selection in the editor. The view (overlays.ts) says when it shows, where the selection is and which
   * buttons are lit or disabled; it sits centred above the selection's first row, or below
   * its last row when the pane has no room above, and inside the pane, never over the
   * selected text: with no room either side it hides. It scrolls with the text. A press
   * toggles through the engine without taking focus or the selection from the editor. Link,
   * after Code, opens the Link prompt (linkPrompt.ts). */
  import { Bold, Code, Italic, Link, Strikethrough, TextQuote } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import type { BlockCommand, InlineFormat } from '@futo-notes/editor/wasm-payloads';
  import { puppetRefusal, puppetVerb, registerPuppetVerbs } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';
  import { BLOCK_ITEMS } from './blockButtons';
  import { FORMATS } from './formats';
  import type { ToolbarState } from './overlays';

  interface Props {
    toolbar: ToolbarState | null;
    ontoggle: (format: InlineFormat) => void;
    onblock: (command: BlockCommand) => void;
    /** The Link button: the Link prompt (linkPrompt.ts). */
    onlink: () => void;
  }

  let { toolbar, ontoggle, onblock, onlink }: Props = $props();

  const BUTTONS: Record<InlineFormat, { labelPath: string; icon: Component; verb: string }> = {
    Bold: { labelPath: 'editor.selectionToolbar.bold', icon: Bold, verb: 'Bold' },
    Italic: { labelPath: 'editor.selectionToolbar.italic', icon: Italic, verb: 'Italic' },
    Strike: {
      labelPath: 'editor.selectionToolbar.strikethrough',
      icon: Strikethrough,
      verb: 'Strikethrough',
    },
    Code: { labelPath: 'editor.selectionToolbar.code', icon: Code, verb: 'Code' },
  };

  /** Between the toolbar and the selection, and between it and the pane's sides. */
  const GAP = 8;

  // The toolbar is always laid out (hidden, not removed), so its size is known before it shows.
  let width = $state(0);
  let height = $state(0);

  const position = $derived.by(() => {
    if (!toolbar) return null;
    const above = toolbar.top - GAP - height;
    const below = toolbar.bottom + GAP;
    let top: number | null = null;
    if (above >= toolbar.paneTop) top = above;
    else if (below + height <= toolbar.paneBottom) top = below;
    if (top === null) return null;
    const centred = (toolbar.left + toolbar.right - width) / 2;
    return { left: Math.max(GAP, Math.min(centred, toolbar.width - GAP - width)), top };
  });

  const stateOf = (format: InlineFormat) =>
    toolbar?.buttons.find((button) => button.format === format);
  const blockOf = (id: string) => toolbar?.blocks.find((button) => button.id === id);

  /** A manifest item's verb name: `heading-2` is Heading2, as the other editors name it. */
  const verbNameOf = (id: string): string =>
    id.replace(/(^|-)([a-z0-9])/g, (_, __, letter: string) => letter.toUpperCase());

  const greyedOut = (verb: string) =>
    puppetRefusal(409, `${verb} is greyed out for this selection`);

  /* Each button, as a verb while the toolbar shows: the same press. */
  $effect(() =>
    registerPuppetVerbs(() => {
      if (position === null) return [];
      return [
        ...BLOCK_ITEMS.map((item) => {
          const verb = verbNameOf(item.id);
          return puppetVerb(
            verb,
            {},
            () => {
              const button = blockOf(item.id);
              if (!button || button.disabled) return greyedOut(verb);
              onblock(button.command);
              return undefined;
            },
            { controls: [item.localizationPath] },
          );
        }),
        ...FORMATS.map((format) => {
          const { verb, labelPath } = BUTTONS[format];
          return puppetVerb(
            verb,
            {},
            () => {
              if (stateOf(format)?.disabled) return greyedOut(verb);
              ontoggle(format);
              return undefined;
            },
            { controls: [labelPath] },
          );
        }),
        puppetVerb(
          'LinkSelection',
          {},
          () => {
            if (toolbar?.linkDisabled) return greyedOut('LinkSelection');
            onlink();
            return undefined;
          },
          { controls: ['editor.selectionToolbar.link'] },
        ),
      ];
    }),
  );
</script>

<div
  class="desktop-format-toolbar"
  class:shown={position !== null}
  role="toolbar"
  aria-label={localizedText('editor.selectionToolbar.accessibilityLabel')}
  aria-hidden={position === null}
  style:transform={position ? `translate(${position.left}px, ${position.top}px)` : undefined}
  bind:offsetWidth={width}
  bind:offsetHeight={height}
>
  {#each BLOCK_ITEMS as item (item.id)}
    {@const button = blockOf(item.id)}
    <button
      type="button"
      tabindex="-1"
      class:lit={button?.lit}
      aria-label={localizedText(item.localizationPath)}
      aria-pressed={button?.lit ?? false}
      disabled={button?.disabled ?? false}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => button && onblock(button.command)}
      >{#if item.text}{item.text}{:else}<TextQuote size={16} strokeWidth={2.25} />{/if}</button
    >
  {/each}
  <span class="separator"></span>
  {#each FORMATS as format (format)}
    {@const Icon = BUTTONS[format].icon}
    {@const button = stateOf(format)}
    <button
      type="button"
      tabindex="-1"
      class:lit={button?.lit}
      aria-label={localizedText(BUTTONS[format].labelPath)}
      aria-pressed={button?.lit ?? false}
      disabled={button?.disabled ?? false}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => ontoggle(format)}><Icon size={16} strokeWidth={2.25} /></button
    >
  {/each}
  <button
    type="button"
    tabindex="-1"
    class:lit={toolbar?.link}
    aria-label={localizedText('editor.selectionToolbar.link')}
    aria-pressed={toolbar?.link ?? false}
    disabled={toolbar?.linkDisabled ?? false}
    onmousedown={(event) => event.preventDefault()}
    onclick={onlink}><Link size={16} strokeWidth={2.25} /></button
  >
</div>

<style>
  /* The old desktop toolbar's look (milkdownEditor.css `.futo-selection-toolbar`). */
  .desktop-format-toolbar {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    max-width: calc(100% - 16px);
    padding: 4px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    font-family: var(--font-sans);
    font-size: 13px;
    visibility: hidden;
  }

  .desktop-format-toolbar.shown {
    visibility: visible;
  }

  button {
    width: 30px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: rgba(var(--ink-rgb), 0.06);
  }

  button.lit {
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
  }

  .separator {
    width: 1px;
    height: 18px;
    background: var(--color-border);
    margin: 0 3px;
  }

  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
