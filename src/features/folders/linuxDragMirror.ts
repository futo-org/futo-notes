import { isLinux } from '$lib/platform';

export interface LinuxDragMirror {
  setDragImage: (event: DragEvent) => void;
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

  function setDragImage(event: DragEvent): void {
    if (!isLinux) return;
    const source = event.currentTarget as HTMLElement | null;
    if (!source) return;

    suppressSystemDragImage(event);
    try {
      teardown();
      const rect = source.getBoundingClientRect();
      const computed = getComputedStyle(source);
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
      mirror.style.transform = `translate(${event.clientX - rect.width / 2}px, ${event.clientY - rect.height / 2}px)`;
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
          mirror.style.transform = `translate(${lastEvent.clientX - rect.width / 2}px, ${lastEvent.clientY - rect.height / 2}px)`;
        });
      };
      document.addEventListener('dragover', handleDragOver, { capture: true });
    } catch (error) {
      console.warn('[drag] mirror setup failed', error);
    }
  }

  return { setDragImage, teardown };
}
