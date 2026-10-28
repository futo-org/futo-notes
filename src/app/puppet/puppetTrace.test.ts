// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import StateToggleFixture from './puppetTrace.fixture.svelte';
import { handlersOf } from './puppetElements';
import { runPuppetCommand } from './puppetInspector';
import { installListenerRegistry, listenersOf } from './puppetListeners';
import { puppetProviders, registerPuppetShell } from './puppetRegistry';
import {
  eventsSince,
  installTrace,
  lastEventId,
  resetTrace,
  type ActionRecord,
  type TraceEvent,
} from './puppetTrace';
import {
  diffElements,
  diffText,
  isEmptyDiff,
  takeSnapshot,
  type SnapshotDiff,
} from './puppetSnapshots';

// Before any listener exists, in the app's order: the app installs these before it mounts.
installTrace();
installListenerRegistry();

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function button(label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  // jsdom lays nothing out; a snapshot keeps only elements with a visible rect.
  element.getBoundingClientRect = () => new DOMRect(1, 1, 10, 10);
  document.body.appendChild(element);
  return element;
}

const eventsSymbol = (element: Element) =>
  Object.getOwnPropertySymbols(element).find((s) => s.description === 'events')!;

afterEach(() => {
  puppetProviders.editor = null;
  puppetProviders.shell = null;
  document.body.innerHTML = '';
  resetTrace();
});

describe('listener registry', () => {
  it('records a bare addEventListener call against the window, as the page resolves it', () => {
    // Milkdown's ctx timers call `addEventListener(…)` with no receiver; the registry threw on
    // it and the editor never started in a dev build. In a page that call reaches the patched
    // prototype method with `this` undefined (jsdom's global keeps the unpatched one).
    const { addEventListener: add, removeEventListener: remove } = EventTarget.prototype;
    const tick = function onTick() {};
    expect(() => add.call(undefined, 'futo-tick', tick)).not.toThrow();
    expect(listenersOf(window).map((r) => `${r.type}=${r.name}`)).toContain('futo-tick=onTick');
    remove.call(undefined, 'futo-tick', tick);
    expect(listenersOf(window).map((r) => r.type)).not.toContain('futo-tick');
  });

  it('names registered listeners and forgets removed and once listeners', async () => {
    const element = button('save');
    const onClick = function onSave() {};
    element.addEventListener('click', onClick);
    element.addEventListener('keydown', () => {}, { once: true });
    expect(listenersOf(element).map((r) => `${r.type}=${r.name}`)).toEqual([
      'click=onSave',
      'keydown=anonymous',
    ]);
    expect(handlersOf(element)).toEqual(['click=onSave', 'keydown=anonymous']);

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    element.removeEventListener('click', onClick);
    expect(listenersOf(element)).toEqual([]);
    await settle();
  });

  it('keeps one record per listener the browser keeps', () => {
    const element = button('save');
    const onClick = function onSave() {};
    element.addEventListener('click', onClick);
    element.addEventListener('click', onClick);
    element.removeEventListener('click', onClick);
    expect(listenersOf(element)).toEqual([]);

    // The second add is not `once`, so the key press leaves it in place.
    let pressed = 0;
    const onKey = function onPress() {
      pressed++;
    };
    element.addEventListener('keydown', onKey, { once: true });
    element.removeEventListener('keydown', onKey);
    element.addEventListener('keydown', onKey);
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(pressed).toBe(2);
    expect(listenersOf(element).map((r) => `${r.type}=${r.name}`)).toEqual(['keydown=onPress']);
  });
});

describe('events', () => {
  it('records the target, the handlers in order, and what each prevented', async () => {
    const outer = document.createElement('div');
    const inner = button('go');
    outer.appendChild(inner);
    document.body.appendChild(outer);
    inner.addEventListener('click', function first(event) {
      event.preventDefault();
    });
    outer.addEventListener('click', function second(event) {
      event.stopPropagation();
    });

    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();

    const [event] = eventsSince(0);
    expect(event).toMatchObject({ type: 'click', trusted: false });
    expect(
      event!.handlers.map((h) => [h.fn, h.on === event!.target, h.prevented, h.stopped]),
    ).toEqual([
      ['first', true, true, false],
      ['second', false, false, true],
    ]);
  });

  it('records Svelte delegated handlers by wrapping the per-element table', async () => {
    const element = button('tab');
    const ran: string[] = [];
    const table = {
      click: function selectTab() {
        ran.push('selectTab');
      },
    };
    (element as unknown as Record<symbol, unknown>)[Symbol('events')] = table;
    // Svelte's root delegator: reads the table at dispatch time.
    const root = document.createElement('div');
    root.appendChild(element);
    document.body.appendChild(root);
    root.addEventListener('click', function handle_event_propagation(event) {
      const target = event.target as Element;
      (target as unknown as Record<symbol, Record<string, (e: Event) => void>>)[
        eventsSymbol(target)
      ]!.click!.call(target, event);
    });

    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(ran).toEqual(['selectTab']);
    const [event] = eventsSince(0);
    expect(event!.handlers.map((h) => h.fn)).toEqual(['selectTab']);
    expect(handlersOf(element)).toEqual(['click=selectTab']);
    // The delegator itself is plumbing: neither a handler run nor a row entry.
    expect(handlersOf(root)).toEqual([]);
  });

  it('records a wheel with its point, so a scroll gesture is seen landing', async () => {
    button('row').dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, clientX: 130, clientY: 600, deltaY: 40 }),
    );
    await settle();

    expect(eventsSince(0)[0]).toMatchObject({ type: 'wheel', x: 130, y: 600 });
  });

  it('answers events since a cursor and one event by id', async () => {
    const cursor = lastEventId();
    button('a').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    const since = runPuppetCommand('events', { since: cursor + 1 }).body as {
      last: number;
      events: TraceEvent[];
    };
    expect(since.last).toBe(cursor + 2);
    expect(since.events.map((e) => e.id)).toEqual([cursor + 2]);
    expect((runPuppetCommand('events', { id: cursor + 1 }).body as TraceEvent).id).toBe(cursor + 1);
    expect(runPuppetCommand('events', { id: cursor + 9 }).status).toBe(404);
  });
});

describe('diff', () => {
  it('reduces a document change to one hunk, on the line it starts', () => {
    expect(
      diffText(
        'paragraph│one\nparagraph│the quick brown fox',
        'paragraph│one\nparagraph│the quick **brown** fox',
      ),
    ).toEqual({ line: 2, removed: 'brown', inserted: '**brown**' });
    expect(diffText('abc', 'abc')).toBeUndefined();
    expect(diffText('abc', 'ac')).toEqual({ line: 1, removed: 'b', inserted: '' });
  });

  it('reports added, removed and changed element rows by ref', () => {
    const row = (ref: string, x: number, flags: string[] = []) => ({
      ref,
      component: null,
      role: 'button',
      text: ref,
      handlers: [],
      flags,
      rect: { x, y: 0, w: 10, h: 10 },
    });
    const diff = diffElements(
      [row('e1', 0), row('e2', 0)],
      [row('e2', 5, ['focused']), row('e3', 0)],
    );
    expect(diff.added.map((r) => r.ref)).toEqual(['e3']);
    expect(diff.removed.map((r) => r.ref)).toEqual(['e1']);
    expect(diff.changed).toEqual([
      {
        ref: 'e2',
        component: null,
        role: 'button',
        text: 'e2',
        rect: [
          { x: 0, y: 0, w: 10, h: 10 },
          { x: 5, y: 0, w: 10, h: 10 },
        ],
        flags: [[], ['focused']],
      },
    ]);
  });

  it('diffs two snapshots by id', () => {
    const before = takeSnapshot();
    button('new');
    const after = takeSnapshot();
    const diff = runPuppetCommand('diff', { from: before.id, to: after.id }).body as SnapshotDiff;
    expect(diff.elements.added.map((r) => r.text)).toEqual(['new']);
    expect(runPuppetCommand('diff', { from: before.id, to: 99 }).status).toBe(404);
  });
});

describe('gesture bracketing', () => {
  it('end answers with the diff and the events since begin', async () => {
    const begun = runPuppetCommand('trace', { begin: true }).body as { eventCursor: number };
    expect(begun.eventCursor).toBe(lastEventId());
    const target = button('tap me');
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 3, clientY: 4 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3, clientY: 4 }));
    await settle();

    const ended = runPuppetCommand('trace', { end: true }).body as ActionRecord & {
      trace: TraceEvent[];
    };
    expect(ended.kind).toBe('gesture');
    expect(ended.trace.map((e) => e.type)).toEqual(['mousedown', 'click']);
    expect(ended.diff.elements.added.map((r) => r.text)).toEqual(['tap me']);
    expect(runPuppetCommand('trace', { end: true }).status).toBe(409);
    expect(runPuppetCommand('trace', {}).status).toBe(400);
  });

  /** A drag that begins on selected text must stay a selection drag, never an OS drag-and-drop. */
  it('cancels dragstart only while a gesture is bracketed', () => {
    const dragstart = () => {
      const event = new Event('dragstart', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(dragstart()).toBe(false);
    runPuppetCommand('trace', { begin: true });
    expect(dragstart()).toBe(true);
    runPuppetCommand('trace', { end: true });
    expect(dragstart()).toBe(false);
  });

  it('lets a drag the app starts itself go ahead: a draggable tab or row', () => {
    const tab = button('work/standup');
    tab.draggable = true;
    const text = document.createElement('p');
    text.textContent = 'selected words';
    document.body.append(text);
    const dragstart = (from: Node) => {
      const event = new Event('dragstart', { bubbles: true, cancelable: true });
      from.dispatchEvent(event);
      return event.defaultPrevented;
    };
    runPuppetCommand('trace', { begin: true });
    expect(dragstart(tab.firstChild!)).toBe(false);
    expect(dragstart(text.firstChild!)).toBe(true);
    runPuppetCommand('trace', { end: true });
  });
});

describe('elements changed', () => {
  it('reports only what moved since the previous elements call', () => {
    button('stay');
    expect(runPuppetCommand('elements', { changed: true }).status).toBe(409);
    runPuppetCommand('elements', {});
    const added = button('fresh');
    const body = runPuppetCommand('elements', { changed: true }).body as {
      added: Array<{ text: string }>;
      removed: unknown[];
      changed: unknown[];
    };
    expect(body.added.map((r) => r.text)).toEqual(['fresh']);
    expect(body.removed).toEqual([]);
    added.remove();
    const next = runPuppetCommand('elements', { changed: true }).body as {
      added: unknown[];
      removed: Array<{ text: string }>;
    };
    expect(next.added).toEqual([]);
    expect(next.removed.map((r) => r.text)).toEqual(['fresh']);
  });
});

describe('receipts see what the verb did on screen', () => {
  // jsdom lays nothing out; a snapshot keeps only elements with a visible rect.
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  const mountFixture = () => {
    HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(1, 1, 10, 10);
    registerPuppetShell({ screen: () => 'home', state: () => ({}) });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(StateToggleFixture, { target });
    flushSync();
    return () => {
      unmount(app);
      HTMLElement.prototype.getBoundingClientRect = realRect;
    };
  };

  it('a verb that only flips component state shows the control it opened', () => {
    const cleanup = mountFixture();
    const done = runPuppetCommand('do', { verb: 'ToggleFixture', args: {} }).body as {
      diff?: SnapshotDiff;
    };
    expect(done.diff?.elements.added.map((row) => row.text)).toEqual(['Close']);
    cleanup();
  });

  it('the next receipt says the page changed after the last one with no input between', async () => {
    const cleanup = mountFixture();
    const first = runPuppetCommand('do', { verb: 'ToggleFixtureLater', args: {} }).body as {
      action: number;
      diff?: SnapshotDiff;
    };
    expect(first.diff).toBeUndefined();
    await settle();
    const next = runPuppetCommand('do', { verb: 'ToggleFixture', args: {} }).body as {
      changedSinceLast?: { action: number; diff: SnapshotDiff };
    };
    expect(next.changedSinceLast?.action).toBe(first.action);
    expect(next.changedSinceLast?.diff.elements.added.map((row) => row.text)).toEqual(['Close']);
    cleanup();
  });
});
