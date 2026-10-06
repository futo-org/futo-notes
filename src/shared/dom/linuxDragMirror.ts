/*
 * WebKitGTK's native drag image comes out the wrong size on a scaled Linux
 * desktop (too big at KDE Wayland's 1.6x), and no ratio read from the page
 * undoes it. So on Linux, callers hand the drag here: the native image becomes
 * a blank pixel and the preview is a copy of the dragged element on the page,
 * following the pointer.
 */
export interface LinuxDragMirror {
  /**
   * `source` defaults to the element the drag started on; `grab` is where the
   * pointer holds the preview, in CSS pixels from its top-left corner
   * (default: its center).
   */
  setDragImage: (event: DragEvent, source?: HTMLElement, grab?: { x: number; y: number }) => void;
  teardown: () => void;
}

export function createLinuxDragMirror(): LinuxDragMirror {
  let mirrorElement: HTMLElement | null = null;
  let handleDragOver: ((event: DragEvent) => void) | null = null;

  function teardown(): void {
    if (handleDragOver) {
      document.removeEventListener('dragover', handleDragOver, { capture: true });
      handleDragOver = null;
    }
    mirrorElement?.remove();
    mirrorElement = null;
  }

  function suppressSystemDragImage(event: DragEvent): void {
    if (!event.dataTransfer) return;
    try {
      const blank = document.createElement('canvas');
      blank.width = 1;
      blank.height = 1;
      blank.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
      document.body.appendChild(blank);
      event.dataTransfer.setDragImage(blank, 0, 0);
      window.setTimeout(() => blank.remove(), 0);
    } catch (error) {
      console.warn('[drag] setDragImage suppression failed', error);
    }
  }

  function setDragImage(
    event: DragEvent,
    source = event.currentTarget as HTMLElement | null,
    grab?: { x: number; y: number },
  ): void {
    if (!source) return;

    suppressSystemDragImage(event);
    try {
      teardown();
      const rect = source.getBoundingClientRect();
      const computed = getComputedStyle(source);
      const grabX = grab?.x ?? rect.width / 2;
      const grabY = grab?.y ?? rect.height / 2;
      const mirror = source.cloneNode(true) as HTMLElement;
      mirror.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        'pointer-events:none',
        'z-index:99999',
        'opacity:0.92',
        'background:var(--color-surface, rgba(0,0,0,0.06))',
        `color:${computed.color}`,
        `font:${computed.font}`,
        'border-radius:10px',
        'box-shadow:0 4px 14px rgba(0, 0, 0, 0.22)',
        'will-change:transform',
      ].join(';');
      mirror.style.transform = `translate(${event.clientX - grabX}px, ${event.clientY - grabY}px)`;
      document.body.appendChild(mirror);
      mirrorElement = mirror;

      let animationPending = false;
      let lastEvent: DragEvent | null = null;
      handleDragOver = (moveEvent) => {
        if (moveEvent.clientX === 0 && moveEvent.clientY === 0) return;
        lastEvent = moveEvent;
        if (animationPending) return;
        animationPending = true;
        requestAnimationFrame(() => {
          animationPending = false;
          if (!lastEvent) return;
          mirror.style.transform = `translate(${lastEvent.clientX - grabX}px, ${lastEvent.clientY - grabY}px)`;
        });
      };
      document.addEventListener('dragover', handleDragOver, { capture: true });
    } catch (error) {
      console.warn('[drag] mirror setup failed', error);
    }
  }

  return { setDragImage, teardown };
}
