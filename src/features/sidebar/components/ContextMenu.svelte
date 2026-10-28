<script lang="ts">
  import { dismissable } from '$shared/dialogs/dismissable';
  import { portal } from '$shared/dom/portal';
  import { ANSWER_PARAM, throughConfirmation } from '$app/puppet/puppetConfirm';
  import {
    puppetRefusal,
    puppetVerb,
    registerPuppetVerbs,
    type PuppetShortcutSteps,
  } from '$app/puppet/puppetRegistry';
  import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';

  export interface MenuItem {
    label: LocalizedMessage;
    onclick: () => unknown;
    destructive?: boolean;
    disabled?: boolean;
    /**
     * The option as a `futo-puppet` verb while the menu is open: its name, the shortcut
     * argument of the step it opens (`shortcuts` in puppetRegistry.ts), and whether it asks
     * "are you sure?", which `answer` answers (puppetConfirm.ts).
     */
    verb: {
      name: string;
      shortcut?: { argument: string; steps: PuppetShortcutSteps };
      confirms?: true;
    };
  }

  interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    /** The row it acts on, which the agent's `elements` reads as its section: `menu · note "<id>"`. */
    openFor?: string;
    onclose: () => void;
  }

  let { x, y, items, openFor, onclose }: Props = $props();

  /** Returns the option's own result, which a confirming one's verb answers after. */
  function handleItemClick(item: MenuItem): unknown {
    const done = item.onclick();
    onclose();
    return done;
  }

  // Each option is a verb while the menu is up, acting on the row it was opened for.
  $effect(() =>
    registerPuppetVerbs(() => [
      ...items.map((item) =>
        puppetVerb(
          item.verb.name,
          {
            ...(item.verb.shortcut ? { [item.verb.shortcut.argument]: 'string?' } : {}),
            ...(item.verb.confirms ? ANSWER_PARAM : {}),
          },
          () => {
            if (item.disabled) return puppetRefusal(409, `${item.verb.name} is disabled`);
            if (!item.verb.confirms) return void handleItemClick(item);
            return throughConfirmation(async () => handleItemClick(item));
          },
          {
            controls: [item.label.path],
            ...(item.verb.shortcut
              ? { shortcuts: { [item.verb.shortcut.argument]: item.verb.shortcut.steps } }
              : {}),
          },
        ),
      ),
      puppetVerb('CloseContextMenu', {}, onclose),
    ]),
  );
</script>

<div
  use:portal
  use:dismissable={{ ondismiss: onclose, outside: true }}
  class="context-menu"
  style="left: {x}px; top: {y}px"
  role="menu"
  data-puppet-section={openFor}
>
  {#each items as item (`${item.label.path}:${JSON.stringify(item.label.arguments ?? {})}`)}
    <button
      type="button"
      role="menuitem"
      class="menu-item"
      class:destructive={item.destructive}
      disabled={item.disabled}
      onclick={() => handleItemClick(item)}>{resolveLocalizedMessage(item.label)}</button
    >
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: var(--z-overlay);
    min-width: 160px;
    background: var(--color-bg, #fff);
    color: var(--color-text, #000);
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    padding: 4px 0;
  }
  .menu-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
    color: inherit;
  }
  .menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .menu-item:hover:not(:disabled) {
    background: var(--color-surface, rgba(0, 0, 0, 0.06));
  }
  .menu-item.destructive {
    color: #b91c1c;
  }
</style>
