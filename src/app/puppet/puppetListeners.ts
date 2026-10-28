/**
 * Every `addEventListener` on the page, remembered: the inspector names an
 * element's handlers from it and the trace records which of them ran.
 *
 * Installed synchronously before the app mounts (installPuppetInspector.ts):
 * ProseMirror and Svelte attach their listeners at mount, and a listener added
 * before the patch is invisible to both consumers.
 */

interface ListenerRecord {
  type: string;
  name: string;
  capture: boolean;
  listener: Listener;
  once: boolean;
}

type Listener = EventListenerOrEventListenerObject;

/** Runs one listener call; the trace measures around `invoke`. */
type HandlerRunHook = (event: Event, target: EventTarget, name: string, invoke: () => void) => void;

const recordsByTarget = new WeakMap<EventTarget, ListenerRecord[]>();
// One wrapper per (listener, type, capture) so removeEventListener still matches.
const wrappersByListener = new WeakMap<object, Map<string, EventListener>>();
let hook: HandlerRunHook | null = null;
let installed = false;

export function setHandlerRunHook(next: HandlerRunHook | null): void {
  hook = next;
}

export function listenersOf(target: EventTarget): readonly ListenerRecord[] {
  return recordsByTarget.get(target) ?? [];
}

function nameOfListener(listener: Listener): string {
  const fn = typeof listener === 'function' ? listener : listener.handleEvent;
  return fn?.name || 'anonymous';
}

function captureOf(options: boolean | AddEventListenerOptions | undefined): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

/** The record of `listener` on `target`: one at most, as the browser keeps one. */
function recordOf(
  target: EventTarget,
  type: string,
  listener: Listener,
  capture: boolean,
): ListenerRecord | undefined {
  return recordsByTarget
    .get(target)
    ?.find((r) => r.type === type && r.listener === listener && r.capture === capture);
}

function forget(target: EventTarget, record: ListenerRecord | undefined): void {
  const records = recordsByTarget.get(target);
  if (records && record) records.splice(records.indexOf(record), 1);
}

export function installListenerRegistry(): void {
  if (installed) return;
  installed = true;
  const prototype = EventTarget.prototype;
  const originalAdd = prototype.addEventListener;
  const originalRemove = prototype.removeEventListener;

  // A bare `addEventListener(…)` call — Milkdown's ctx timers make one — has no receiver, which
  // the platform resolves to the global object; the registry files it under the window. An
  // undefined `this` as a WeakMap key threw, and the editor never started in a dev build.
  prototype.addEventListener = function (
    this: EventTarget | undefined,
    type: string,
    listener: Listener | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    const target: EventTarget = this ?? window;
    if (!listener) return originalAdd.call(this, type, listener, options);
    const capture = captureOf(options);
    let wrappers = wrappersByListener.get(listener);
    if (!wrappers) {
      wrappers = new Map();
      wrappersByListener.set(listener, wrappers);
    }
    const key = `${type}:${capture}`;
    let wrapper = wrappers.get(key);
    if (!wrapper) {
      const name = nameOfListener(listener);
      wrapper = function (this: EventTarget, event: Event) {
        const record = recordOf(this, type, listener, capture);
        if (record?.once) forget(this, record);
        const invoke = () =>
          typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
        if (hook) hook(event, this, name, invoke);
        else invoke();
      };
      wrappers.set(key, wrapper);
    }
    if (!recordOf(target, type, listener, capture)) {
      const records = recordsByTarget.get(target) ?? [];
      const once = typeof options === 'object' && options.once === true;
      records.push({ type, name: nameOfListener(listener), capture, listener, once });
      recordsByTarget.set(target, records);
    }
    return originalAdd.call(this, type, wrapper, options);
  };

  prototype.removeEventListener = function (
    this: EventTarget | undefined,
    type: string,
    listener: Listener | null,
    options?: boolean | EventListenerOptions,
  ) {
    const target: EventTarget = this ?? window;
    const capture = captureOf(options);
    const wrapper = listener ? wrappersByListener.get(listener)?.get(`${type}:${capture}`) : null;
    if (listener && wrapper) forget(target, recordOf(target, type, listener, capture));
    return originalRemove.call(this, type, wrapper ?? listener, options);
  };
}
