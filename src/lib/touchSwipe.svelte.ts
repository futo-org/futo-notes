/**
 * Touch/swipe gesture handler for mobile drawer and graph sidebar.
 *
 * Manages edge swipe detection, velocity tracking, drag progress,
 * and rAF-based direct DOM manipulation during drags.
 */

import { isItemDragging } from './dragState';

export interface TouchSwipeConfig {
  getDrawerWidth: () => number;
  getDrawerOpen: () => boolean;
  getGraphSidebarOpen: () => boolean;
  getGraphSidebarEl: () => HTMLElement | undefined;
  getGraphOverlayEl: () => HTMLElement | undefined;
  getNoteMainEl: () => HTMLElement | undefined;
  getDrawerEl: () => HTMLElement | undefined;
  getMenuButtonEl: () => HTMLElement | undefined;
  getNoteMenuAnchorEl: () => HTMLElement | undefined;
  getOverlayEl: () => HTMLElement | undefined;
  isSwipeExcluded: (target: EventTarget | null) => boolean;
  isComposing: () => boolean;
  blurEditor: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerProgress: (progress: number) => void;
  openGraphSidebar: () => void;
  closeGraphSidebar: () => void;
  isMobile: boolean;
}

export interface TouchSwipeState {
  isDragging: boolean;
  drawerProgress: number;
}

// eslint-disable-next-line max-lines-per-function -- Gesture state and DOM frame updates share mutable drag state and are easier to reason about together.
export function createTouchSwipe(config: TouchSwipeConfig) {
  // Internal state — plain JS, not reactive (performance-critical during drag)
  let tracking = false;
  let isDragging = $state(false);
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let ignoreSwipe = false;
  let edgeSwipe = false;
  let rightSwipe = false;
  let startProgress = 0;
  let rightDragProgress = 0;
  let dragProgress = 0;
  let rafId = 0;

  function applyDragFrame(): void {
    rafId = 0;
    const drawerWidth = config.getDrawerWidth();
    const noteMainEl = config.getNoteMainEl();
    const drawerEl = config.getDrawerEl();
    const menuButtonEl = config.getMenuButtonEl();
    const noteMenuAnchorEl = config.getNoteMenuAnchorEl();
    const overlayEl = config.getOverlayEl();
    const offset = dragProgress * drawerWidth;
    if (noteMainEl) noteMainEl.style.transform = `translateX(${offset}px)`;
    if (drawerEl) drawerEl.style.transform = `translateX(${offset - drawerWidth}px)`;
    if (menuButtonEl) menuButtonEl.style.transform = `translateX(${offset}px)`;
    if (noteMenuAnchorEl) noteMenuAnchorEl.style.transform = `translateX(${offset}px)`;
    if (overlayEl) overlayEl.style.opacity = config.isMobile ? `${dragProgress * 0.5}` : '0';
  }

  function scheduleFrame(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(applyDragFrame);
  }

  function applyRightDragFrame(): void {
    const graphSidebarEl = config.getGraphSidebarEl();
    const graphOverlayEl = config.getGraphOverlayEl();
    const graphWidth = graphSidebarEl?.getBoundingClientRect().width || 320;
    const offset = (1 - rightDragProgress) * graphWidth;
    if (graphSidebarEl) graphSidebarEl.style.transform = `translateX(${offset}px)`;
    if (graphOverlayEl) graphOverlayEl.style.opacity = `${rightDragProgress * 0.3}`;
  }

  function handleTouchStart(event: TouchEvent): void {
    if (!config.isMobile) return;
    if (event.touches.length !== 1) return;
    if (config.isSwipeExcluded(event.target)) {
      tracking = false;
      ignoreSwipe = true;
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    isDragging = false;
    startX = touch.clientX;
    startY = touch.clientY;
    lastX = startX;
    lastTime = Date.now();
    velocity = 0;
    ignoreSwipe = false;
    edgeSwipe = touch.clientX < 30;
    rightSwipe = touch.clientX > window.innerWidth - 30;
    if (rightSwipe) {
      startProgress = config.getGraphSidebarOpen() ? 1 : 0;
      rightDragProgress = startProgress;
    } else {
      startProgress = config.getDrawerOpen() ? 1 : 0;
      dragProgress = startProgress;
      config.setDrawerProgress(startProgress);
    }
  }

  function handleTouchMove(event: TouchEvent): void {
    if (ignoreSwipe || !tracking || event.touches.length !== 1) return;
    // A note/folder drag in the sidebar takes ownership of the touch
    // — don't slide the drawer underneath while the user is dragging
    // a row sideways into a folder.
    if (isItemDragging()) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const isEdge = edgeSwipe || rightSwipe;
    const isVertical = isEdge
      ? Math.abs(deltaY) > 2 * Math.abs(deltaX)
      : Math.abs(deltaX) < Math.abs(deltaY);
    if (!isDragging && isVertical) return;

    if (rightSwipe) {
      if (!isDragging && Math.abs(deltaX) < 3) return;
      if (!isDragging) {
        isDragging = true;
        config.blurEditor();
      }
      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) velocity = (touch.clientX - lastX) / dt;
      lastX = touch.clientX;
      lastTime = now;
      const graphWidth = config.getGraphSidebarEl()?.getBoundingClientRect().width || 320;
      rightDragProgress = Math.min(1, Math.max(0, startProgress - deltaX / graphWidth));
      applyRightDragFrame();
      event.preventDefault();
      return;
    }

    // Left drawer
    if (startProgress > 0 && Math.abs(deltaX) > Math.abs(deltaY)) {
      event.preventDefault();
    }
    const minDragThreshold = edgeSwipe ? 3 : 5;
    if (!isDragging && Math.abs(deltaX) < minDragThreshold) return;
    if (!isDragging) {
      isDragging = true;
      config.blurEditor();
    }
    const now = Date.now();
    const dt = now - lastTime;
    if (dt > 0) velocity = (touch.clientX - lastX) / dt;
    lastX = touch.clientX;
    lastTime = now;
    dragProgress = Math.min(1, Math.max(0, startProgress + deltaX / config.getDrawerWidth()));
    scheduleFrame();
    event.preventDefault();
  }

  function handleTouchEnd(): void {
    if (isDragging && rightSwipe) {
      const graphSidebarEl = config.getGraphSidebarEl();
      const graphOverlayEl = config.getGraphOverlayEl();
      if (graphSidebarEl) graphSidebarEl.style.transform = '';
      if (graphOverlayEl) graphOverlayEl.style.opacity = '';
      isDragging = false;
      const shouldOpen = Math.abs(velocity) > 0.3 ? velocity < 0 : rightDragProgress >= 0.3;
      requestAnimationFrame(() => {
        if (shouldOpen && !config.getGraphSidebarOpen()) {
          config.openGraphSidebar();
        } else if (!shouldOpen && config.getGraphSidebarOpen()) {
          config.closeGraphSidebar();
        }
      });
      tracking = false;
      ignoreSwipe = false;
      edgeSwipe = false;
      rightSwipe = false;
      velocity = 0;
      return;
    }

    if (isDragging) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // Sync back to Svelte state
      config.setDrawerProgress(dragProgress);
      // Clear inline styles
      const noteMainEl = config.getNoteMainEl();
      const drawerEl = config.getDrawerEl();
      const menuButtonEl = config.getMenuButtonEl();
      const noteMenuAnchorEl = config.getNoteMenuAnchorEl();
      const overlayEl = config.getOverlayEl();
      if (noteMainEl) noteMainEl.style.transform = '';
      if (drawerEl) drawerEl.style.transform = '';
      if (menuButtonEl) menuButtonEl.style.transform = '';
      if (noteMenuAnchorEl) noteMenuAnchorEl.style.transform = '';
      if (overlayEl) overlayEl.style.opacity = config.isMobile ? `${dragProgress * 0.5}` : '0';
      isDragging = false;
      const velocityThreshold = edgeSwipe ? 0.3 : 0.5;
      const shouldOpen = Math.abs(velocity) > velocityThreshold ? velocity > 0 : dragProgress >= 0.3;
      requestAnimationFrame(() => {
        config.setDrawerOpen(shouldOpen);
      });
    }
    tracking = false;
    isDragging = false;
    ignoreSwipe = false;
    edgeSwipe = false;
    rightSwipe = false;
    velocity = 0;
  }

  return {
    get isDragging() { return isDragging; },
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
