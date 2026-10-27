/**
 * The trace: what actually happened on the page, as three records.
 *
 * - Events: every real (or synthetic) input event, captured at the window
 *   before anything else sees it and finalised after dispatch — target,
 *   path, each handler that ran in order with what it prevented or stopped,
 *   and for the editor the position ProseMirror resolved at the point versus
 *   where the selection settled.
 * - Snapshots: derived state taken before and after every action
 *   (puppetSnapshots.ts). The app's state and vault are diffed by futo-puppet
 *   around every action on every target (crates/futo-puppet/src/app.rs).
 * - Actions: one typed verb or one bracketed real-input gesture, with its
 *   before/after snapshot ids, the diff between them and the events in between.
 *
 * Ring-buffered; debug builds only (installPuppetInspector.ts).
 */
import {
  componentOf,
  handlerLabel,
  refOf,
  SVELTE_DELEGATOR,
  svelteEventTable,
} from './puppetElements';
import { setHandlerRunHook } from './puppetListeners';
import { type PuppetOutcome } from './puppetRegistry';
import {
  diffSnapshots,
  editorView,
  isEmptyDiff,
  now,
  push,
  resetSnapshots,
  selectionOf,
  snapshotById,
  takeSnapshot,
  type Selection,
  type Snapshot,
  type SnapshotDiff,
} from './puppetSnapshots';

interface HandlerRun {
  fn: string;
  on: string;
  prevented: boolean;
  stopped: boolean;
  threw?: string;
}

export interface TraceEvent {
  id: number;
  t: number;
  type: string;
  trusted: boolean;
  x?: number;
  y?: number;
  key?: string;
  modifiers?: string;
  data?: string;
  target: string;
  component: string | null;
  handlers: HandlerRun[];
  /** Pointer events over the editor: where ProseMirror resolved the point, then where the selection settled. */
  editor?: { resolved: number | null; settled?: Selection };
  /** `selectionchange`: the editor selection at that moment. */
  selection?: Selection;
}

export interface ActionRecord {
  id: number;
  kind: 'do' | 'gesture';
  verb?: string;
  args?: Record<string, unknown>;
  status?: number;
  before: number;
  /** Absent while `pending`: the verb returned a promise that has not settled yet. */
  after?: number;
  diff?: SnapshotDiff;
  /** Event ids in (firstAfterBefore, lastBeforeAfter]: the events this action caused. */
  events: [number, number];
  pending?: true;
  /** A settled async verb's receipt body. */
  result?: unknown;
  /**
   * The page changed after the previous action's receipt with no input in between: what that
   * receipt did not see (a timer, a load, a late render). Never silent, so a lagging receipt is
   * visible on the very next one.
   */
  changedSinceLast?: { action: number; diff: SnapshotDiff };
}

interface PendingAction {
  kind: ActionRecord['kind'];
  verb?: string;
  args?: Record<string, unknown>;
  before: Snapshot;
  eventCursor: number;
  changedSinceLast?: ActionRecord['changedSinceLast'];
}

const POINTER_TYPES = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
];
const KEY_TYPES = [
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionend',
];
const FOCUS_TYPES = ['focusin', 'focusout'];
const TRACED_TYPES = new Set([...POINTER_TYPES, ...KEY_TYPES, ...FOCUS_TYPES]);

const EVENT_LIMIT = 1000;
const ACTION_LIMIT = 100;

const events: TraceEvent[] = [];
const actions: ActionRecord[] = [];
const traceByEvent = new WeakMap<Event, TraceEvent>();
const wrappedDelegated = new WeakSet<(...args: unknown[]) => unknown>();
let nextEventId = 1;
let nextActionId = 1;
let pendingGesture: PendingAction | null = null;
let installed = false;

function nameOfTarget(target: EventTarget): string {
  if (target instanceof Element) return refOf(target);
  if (target === window) return 'window';
  if (target === document) return 'document';
  return '?';
}

function componentOfTarget(target: EventTarget): string | null {
  return target instanceof Element ? componentOf(target) : null;
}

// ---------------------------------------------------------------------------
// Events

function pointOf(event: Event): { x: number; y: number } | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

function modifiersOf(event: Event): string | undefined {
  if (!(event instanceof MouseEvent || event instanceof KeyboardEvent)) return undefined;
  const held = [
    event.ctrlKey && 'ctrl',
    event.shiftKey && 'shift',
    event.altKey && 'alt',
    event.metaKey && 'meta',
  ].filter(Boolean);
  return held.length ? held.join('+') : undefined;
}

function recordHandlerRun(event: Event, target: EventTarget, name: string, invoke: () => void) {
  const trace = traceByEvent.get(event);
  if (!trace || name === SVELTE_DELEGATOR) {
    invoke();
    return;
  }
  const run: HandlerRun = {
    fn: handlerLabel(target, name),
    on: nameOfTarget(target),
    prevented: false,
    stopped: false,
  };
  const preventedBefore = event.defaultPrevented;
  const stoppedBefore = event.cancelBubble;
  try {
    invoke();
  } catch (error) {
    run.threw = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.prevented = event.defaultPrevented && !preventedBefore;
    run.stopped = event.cancelBubble && !stoppedBefore;
    trace.handlers.push(run);
  }
}

/**
 * Svelte 5 delegates events to the root and looks each element's handler up in
 * a private table at dispatch time, so wrapping the table entries along the
 * path — before delegation runs — is what records them.
 */
function wrapDelegatedHandlers(path: EventTarget[], type: string): void {
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    const table = svelteEventTable(node);
    const handler = table?.[type];
    if (!table || typeof handler !== 'function' || wrappedDelegated.has(handler)) continue;
    const name = handler.name || 'anonymous';
    const wrapper = function (this: Element, ...args: unknown[]) {
      recordHandlerRun(args[0] as Event, this, name, () => handler.call(this, ...args));
    };
    Object.defineProperty(wrapper, 'name', { value: name });
    wrappedDelegated.add(wrapper);
    table[type] = wrapper;
  }
}

function capture(event: Event): void {
  const path = event.composedPath();
  const target = path[0] ?? event.target;
  const point = pointOf(event);
  const trace: TraceEvent = {
    id: nextEventId++,
    t: now(),
    type: event.type,
    trusted: event.isTrusted,
    ...(point ? { x: Math.round(point.x), y: Math.round(point.y) } : {}),
    target: target ? nameOfTarget(target) : '?',
    component: target ? componentOfTarget(target) : null,
    handlers: [],
  };
  if (event instanceof KeyboardEvent) trace.key = event.key;
  if (typeof InputEvent !== 'undefined' && event instanceof InputEvent && event.data !== null)
    trace.data = event.data;
  const modifiers = modifiersOf(event);
  if (modifiers) trace.modifiers = modifiers;

  const view = editorView();
  if (view && point && target instanceof Node && view.dom.contains(target)) {
    trace.editor = { resolved: view.posAtCoords({ left: point.x, top: point.y })?.pos ?? null };
  }
  traceByEvent.set(event, trace);
  wrapDelegatedHandlers(path, event.type);
  push(events, trace, EVENT_LIMIT);
  // Where the selection settled, once dispatch completes (a microtask would run between listeners).
  const pointed = trace.editor;
  if (pointed && view) setTimeout(() => (pointed.settled = selectionOf(view)), 0);
}

function onSelectionChange(): void {
  const view = editorView();
  if (!view) return;
  const active = document.activeElement;
  push(
    events,
    {
      id: nextEventId++,
      t: now(),
      type: 'selectionchange',
      trusted: true,
      target: active ? nameOfTarget(active) : 'document',
      component: active ? componentOfTarget(active) : null,
      handlers: [],
      selection: selectionOf(view),
    },
    EVENT_LIMIT,
  );
}

/**
 * Wire the recorder to the page. Idempotent. Call before the listener registry
 * is installed, so these listeners of ours are not recorded as handlers, and
 * before the app mounts, so nothing is dispatched unseen.
 */
export function installTrace(): void {
  if (installed) return;
  installed = true;
  setHandlerRunHook(recordHandlerRun);
  for (const type of TRACED_TYPES) window.addEventListener(type, capture, true);
  document.addEventListener('selectionchange', onSelectionChange);
}

export function eventsSince(since: number): TraceEvent[] {
  return events.filter((event) => event.id > since);
}

export function eventById(id: number): TraceEvent | undefined {
  return events.find((event) => event.id === id);
}

export function lastEventId(): number {
  return nextEventId - 1;
}

// ---------------------------------------------------------------------------
// Actions

function begin(kind: ActionRecord['kind'], verb?: string, args?: Record<string, unknown>) {
  const before = takeSnapshot();
  return {
    kind,
    verb,
    args,
    before,
    eventCursor: lastEventId(),
    changedSinceLast: changedSince(before),
  };
}

/** What changed between the last receipt and now, when no input event came in between. */
function changedSince(before: Snapshot): ActionRecord['changedSinceLast'] {
  const previous = actions[actions.length - 1];
  if (previous?.after === undefined || previous.events[1] !== lastEventId()) return undefined;
  const after = snapshotById(previous.after);
  if (!after) return undefined;
  const diff = diffSnapshots(after, before);
  return isEmptyDiff(diff) ? undefined : { action: previous.id, diff };
}

function end(pending: PendingAction, status?: number): ActionRecord {
  return push(
    actions,
    { id: nextActionId++, kind: pending.kind, ...describe(pending), ...settle(pending, status) },
    ACTION_LIMIT,
  );
}

function describe(
  pending: PendingAction,
): Pick<ActionRecord, 'verb' | 'args' | 'before' | 'changedSinceLast'> {
  return {
    ...(pending.verb ? { verb: pending.verb } : {}),
    ...(pending.args ? { args: pending.args } : {}),
    before: pending.before.id,
    ...(pending.changedSinceLast ? { changedSinceLast: pending.changedSinceLast } : {}),
  };
}

function settle(
  pending: PendingAction,
  status?: number,
): Pick<ActionRecord, 'status' | 'after' | 'diff' | 'events'> {
  const after = takeSnapshot();
  return {
    ...(status === undefined ? {} : { status }),
    after: after.id,
    diff: diffSnapshots(pending.before, after),
    events: [pending.eventCursor, lastEventId()],
  };
}

/**
 * Brackets a verb with snapshots. A synchronous verb's record is complete on
 * return. An async verb gets a `pending` record now and a 202 receipt; the
 * record fills in (after, diff, status, result) when the promise settles, so
 * the CLI can poll `diff {"action"}` for it.
 */
export function recordDo(
  verb: string,
  args: Record<string, unknown>,
  run: () => PuppetOutcome | Promise<PuppetOutcome>,
): { outcome: PuppetOutcome; action: ActionRecord } {
  const pending = begin('do', verb, args);
  const result = run();
  if (!(result instanceof Promise)) return { outcome: result, action: end(pending, result.status) };
  const record = push(
    actions,
    {
      id: nextActionId++,
      kind: 'do' as const,
      ...describe(pending),
      events: [pending.eventCursor, pending.eventCursor] as [number, number],
      pending: true as const,
    },
    ACTION_LIMIT,
  );
  const complete = (status: number, body: unknown): void => {
    Object.assign(record, settle(pending, status), { result: body });
    delete record.pending;
  };
  result.then(
    (outcome) => complete(outcome.status, outcome.body),
    (error: unknown) =>
      complete(500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return { outcome: { status: 202, body: { ok: true, verb, pending: true } }, action: record };
}

/**
 * A synthesized mouse drag that begins on selected text makes WebKit start an
 * OS drag-and-drop session, and only a real mouse-up can end one: until then the
 * window loses key status and every further event — ours included — goes to
 * the session, not the page (measured on macOS: `hasFocus() === false`, three
 * gestures in a row with zero page events). Cancelling that `dragstart` while a
 * gesture is bracketed keeps the pointer sequence a selection drag, which is
 * what an agent dragging across text means. A drag the app starts itself (a
 * `draggable` tab or sidebar row) is the app's to handle, so it goes ahead.
 */
function cancelDragStart(event: Event): void {
  const node = event.target as Node | null;
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element?.closest('[draggable="true"]')) event.preventDefault();
}

/** Real input arrives from outside the page, so its bracket is two calls. */
export function beginGesture(): { before: number; eventCursor: number } {
  pendingGesture = begin('gesture');
  document.addEventListener('dragstart', cancelDragStart, true);
  return { before: pendingGesture.before.id, eventCursor: pendingGesture.eventCursor };
}

export function endGesture(): ActionRecord | null {
  document.removeEventListener('dragstart', cancelDragStart, true);
  if (!pendingGesture) return null;
  const record = end(pendingGesture);
  pendingGesture = null;
  return record;
}

export function actionById(id: number): ActionRecord | undefined {
  return actions.find((action) => action.id === id);
}

export function lastAction(): ActionRecord | undefined {
  return actions[actions.length - 1];
}

/** Test seam: forget everything recorded, keep the wiring. */
export function resetTrace(): void {
  events.length = 0;
  resetSnapshots();
  actions.length = 0;
  pendingGesture = null;
}
