import type { Tab } from './tabsStore.svelte';

interface TabDragOptions {
  activateTab: (tabId: string) => void;
  getStripElement: () => HTMLDivElement | undefined;
  getTabs: () => readonly Tab[];
  moveTab: (fromIndex: number, toIndex: number) => void;
}

interface TabRect {
  left: number;
  width: number;
}

const DRAG_THRESHOLD = 6;
const TAB_GAP = 4;

export function createTabDrag(options: TabDragOptions) {
  let dragTabId = $state<string | null>(null);
  let dragDeltaX = $state(0);
  let dragTargetIndex = $state(-1);
  let dragStartX = 0;
  let dragStartIndex = -1;
  let tabRects: TabRect[] = [];
  let hasDragStarted = false;
  let pendingAnimationCleanup: (() => void) | null = null;

  function handlePointerDown(event: PointerEvent, tab: Tab): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.tab-close-btn')) return;

    pendingAnimationCleanup?.();
    pendingAnimationCleanup = null;
    const startIndex = options.getTabs().findIndex((candidate) => candidate.id === tab.id);
    const stripElement = options.getStripElement();
    if (startIndex === -1 || !stripElement) return;

    tabRects = Array.from(stripElement.querySelectorAll<HTMLElement>('[data-tab-id]')).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      },
    );
    dragTabId = tab.id;
    dragStartIndex = startIndex;
    dragTargetIndex = startIndex;
    dragStartX = event.clientX;
    dragDeltaX = 0;
    hasDragStarted = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (dragTabId === null) return;

    const deltaX = event.clientX - dragStartX;
    if (!hasDragStarted && Math.abs(deltaX) >= DRAG_THRESHOLD) hasDragStarted = true;
    if (!hasDragStarted) return;

    dragDeltaX = deltaX;
    let targetIndex = dragStartIndex;
    for (let index = 0; index < tabRects.length; index += 1) {
      const rect = tabRects[index];
      targetIndex = index;
      if (event.clientX < rect.left + rect.width / 2) break;
    }
    dragTargetIndex = targetIndex;
  }

  function animateDroppedTab(
    tabId: string,
    startIndex: number,
    targetIndex: number,
    finalDeltaX: number,
    draggedWidth: number,
  ): void {
    queueMicrotask(() => {
      const stripElement = options.getStripElement();
      const tabElement = stripElement?.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      if (!tabElement) return;

      const slotShift = (targetIndex - startIndex) * (draggedWidth + TAB_GAP);
      const fromX = finalDeltaX - slotShift;
      if (Math.abs(fromX) < 0.5) return;

      tabElement.style.transition = 'none';
      tabElement.style.transform = `translate3d(${fromX}px, 0, 0)`;
      tabElement.style.zIndex = '2';
      requestAnimationFrame(() => {
        const cleanup = () => {
          tabElement.removeEventListener('transitionend', handleTransitionEnd);
          tabElement.style.transition = '';
          tabElement.style.transform = '';
          tabElement.style.zIndex = '';
        };
        const handleTransitionEnd = () => {
          cleanup();
          if (pendingAnimationCleanup === cleanup) pendingAnimationCleanup = null;
        };

        tabElement.style.transition = 'transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1)';
        tabElement.style.transform = '';
        pendingAnimationCleanup = cleanup;
        tabElement.addEventListener('transitionend', handleTransitionEnd);
      });
    });
  }

  function handlePointerUp(event: PointerEvent, tab: Tab): void {
    const wasDrag = hasDragStarted;
    const tabId = dragTabId;
    const startIndex = dragStartIndex;
    const targetIndex = dragTargetIndex;
    const finalDeltaX = dragDeltaX;
    const draggedWidth = tabRects[startIndex]?.width ?? 0;

    dragTabId = null;
    hasDragStarted = false;
    dragDeltaX = 0;
    dragStartIndex = -1;
    dragTargetIndex = -1;
    tabRects = [];

    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }

    if (!wasDrag && tabId === tab.id) {
      if (event.button === 0) options.activateTab(tab.id);
      return;
    }
    if (tabId === null || targetIndex === -1) return;

    if (targetIndex !== startIndex) options.moveTab(startIndex, targetIndex);
    animateDroppedTab(tabId, startIndex, targetIndex, finalDeltaX, draggedWidth);
  }

  function getTabStyle(tab: Tab, index: number): string {
    if (dragTabId === null) return '';
    if (tab.id === dragTabId) {
      return [
        `transform: translate3d(${dragDeltaX}px, 0, 0) scale(1.03)`,
        'z-index: 2',
        'transition: none',
        'cursor: grabbing',
        'pointer-events: none',
        'box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18)',
      ].join('; ');
    }

    const draggedWidth = tabRects[dragStartIndex]?.width ?? 0;
    let shiftX = 0;
    if (dragTargetIndex > dragStartIndex && index > dragStartIndex && index <= dragTargetIndex) {
      shiftX = -(draggedWidth + TAB_GAP);
    } else if (
      dragTargetIndex < dragStartIndex &&
      index >= dragTargetIndex &&
      index < dragStartIndex
    ) {
      shiftX = draggedWidth + TAB_GAP;
    }
    return `transform: translate3d(${shiftX}px, 0, 0); transition: transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1);`;
  }

  return {
    get dragTabId() {
      return dragTabId;
    },
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    getTabStyle,
  };
}
