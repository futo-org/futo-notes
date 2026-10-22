<script lang="ts">
  import { tabsStore, type Tab } from './tabsStore.svelte';
  import type { NotePreview } from '$shared/types/note';
  import { idLeaf } from '$lib/platform/pathSafety';
  import {
    isPuppetOutcome,
    puppetRefusal,
    puppetVerb,
    registerPuppetVerbs,
    type PuppetOutcome,
  } from '$app/puppet/puppetRegistry';
  import { localizedText } from '$shared/localization';
  import { setAppWindowTitle } from '$lib/platform';
  import './tabsStrip.css';

  interface Props {
    notes?: NotePreview[];
  }

  let { notes = [] }: Props = $props();

  const titleById = $derived.by(() => {
    const m = new Map<string, string>();
    for (const n of notes) m.set(n.id, n.title);
    return m;
  });

  function titleFor(tab: Tab): string {
    const id = tab.noteId;
    if (id === null) return localizedText('tabs.home');
    if (id === 'new') return localizedText('tabs.newNote');
    const title = titleById.get(id);
    if (title) return idLeaf(title) || title;
    return idLeaf(id);
  }

  $effect(() => {
    const activeTab = tabsStore.activeTab;
    setAppWindowTitle(activeTab.noteId === null ? undefined : titleFor(activeTab));
  });

  // NewTab is the shortcut table's, as is ActivateTabByNumber, the Cmd+1..9 keys.
  const tabAt = (index: number) => tabsStore.tabs[index];
  /** `0=welcome 1=work/standup` — every refusal about a tab says which tabs there are. */
  const tabList = () =>
    tabsStore.tabs.map((tab, index) => `${index}=${tab.noteId ?? 'home'}`).join(' ');

  /**
   * Which tab a click means: the one holding `noteId`, what the caller knows. A tab with no
   * note (Cmd+T's), or a note open in two tabs, is named by its 0-based `index` in the strip
   * instead.
   */
  function targetTab(args: Record<string, unknown>): Tab | PuppetOutcome {
    if (typeof args.noteId === 'string') {
      return (
        tabsStore.tabs.find((tab) => tab.noteId === args.noteId) ??
        puppetRefusal(400, `no tab holds ${args.noteId}; open tabs: ${tabList()}`)
      );
    }
    if (typeof args.index === 'number') {
      return (
        tabAt(args.index) ??
        puppetRefusal(
          400,
          `no tab at index ${args.index}: the index is 0-based and the open tabs are ${tabList()}`,
        )
      );
    }
    return puppetRefusal(
      400,
      `needs {"index":<0-based>} or {"noteId":"<the note the tab holds>"}; open tabs: ${tabList()}`,
    );
  }

  const onTargetTab = (act: (tab: Tab) => void) => (args: Record<string, unknown>) => {
    const tab = targetTab(args);
    if (isPuppetOutcome(tab)) return tab;
    act(tab);
    return undefined;
  };

  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb(
        'ActivateTab',
        { noteId: 'string?', index: 'integer?' },
        onTargetTab((tab) => tabsStore.activateById(tab.id)),
        { controlsMatching: '[role="tab"]' },
      ),
      puppetVerb(
        'CloseTabAt',
        { noteId: 'string?', index: 'integer?' },
        onTargetTab((tab) => tabsStore.closeTab(tab.id)),
        { controls: ['tabs.closeAccessibilityLabel'] },
      ),
      puppetVerb('MoveTab', { fromIndex: 'integer', toIndex: 'integer' }, (args) => {
        const from = args.fromIndex as number;
        const to = args.toIndex as number;
        if (!tabAt(from) || !tabAt(to)) {
          return puppetRefusal(400, `indexes are 0-based and the open tabs are ${tabList()}`);
        }
        tabsStore.moveTab(from, to);
        return undefined;
      }),
    ]),
  );

  // HTML5 drag reorder: the tabs move live under the cursor (moveTab on
  // midpoint crossing), so the reordering strip itself is the drop feedback.
  let dragIndex: number | null = $state(null);

  function onDragStart(e: DragEvent, index: number): void {
    if ((e.target as HTMLElement).closest('.tab-close-btn')) {
      e.preventDefault();
      return;
    }
    dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabsStore.tabs[index]?.id ?? '');
    }
  }

  function onDragOver(e: DragEvent, index: number): void {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (index === dragIndex) return;
    // Only reorder once the cursor crosses the hovered tab's midpoint in the
    // direction of travel — reordering on mere overlap oscillates when tabs
    // have different widths.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const movingRight = index > dragIndex;
    if ((movingRight && e.clientX > midpoint) || (!movingRight && e.clientX < midpoint)) {
      tabsStore.moveTab(dragIndex, index);
      dragIndex = index;
    }
  }

  function onDragEnd(): void {
    dragIndex = null;
  }

  function onAuxClick(e: MouseEvent, tab: Tab): void {
    if (e.button === 1) {
      e.preventDefault();
      tabsStore.closeTab(tab.id);
    }
  }

  function onCloseClick(e: MouseEvent, tab: Tab): void {
    e.preventDefault();
    e.stopPropagation();
    tabsStore.closeTab(tab.id);
  }

  function onNewTabClick(): void {
    tabsStore.newTab();
  }
</script>

<div
  class="tabs-strip"
  role="tablist"
  aria-label={localizedText('tabs.accessibilityLabel')}
  data-tauri-drag-region
>
  {#each tabsStore.tabs as tab, idx (tab.id)}
    <button
      type="button"
      class="tab-pill"
      class:active={tab.id === tabsStore.activeTabId}
      class:dragging={idx === dragIndex}
      role="tab"
      aria-selected={tab.id === tabsStore.activeTabId}
      data-tab-id={tab.id}
      draggable="true"
      onclick={() => tabsStore.activateById(tab.id)}
      ondragstart={(e) => onDragStart(e, idx)}
      ondragover={(e) => onDragOver(e, idx)}
      ondrop={(e) => e.preventDefault()}
      ondragend={onDragEnd}
      onauxclick={(e) => onAuxClick(e, tab)}
      title={titleFor(tab)}
    >
      <span class="tab-title">{titleFor(tab)}</span>
      <span
        class="tab-close-btn"
        role="button"
        tabindex="-1"
        aria-label={localizedText('tabs.closeAccessibilityLabel')}
        onclick={(e) => onCloseClick(e, tab)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            tabsStore.closeTab(tab.id);
          }
        }}>×</span
      >
    </button>
  {/each}
  <button
    type="button"
    class="tab-new-btn"
    aria-label={localizedText('tabs.newAccessibilityLabel')}
    title={localizedText('tabs.newAccessibilityLabel')}
    onclick={onNewTabClick}>+</button
  >
</div>
