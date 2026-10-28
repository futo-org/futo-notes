/**
 * DOM side of the puppet inspector: name, measure and classify what is on
 * screen, and say who would take a pointer event at a point.
 *
 * Coordinates are webview CSS pixels, viewport-relative. Element identity is
 * a `eN` reference that stays stable for the life of the page, so the ref one
 * command prints is the ref the next command accepts.
 */

/// <reference lib="es2021.weakref" />
import type { EditorView } from '@milkdown/kit/prose/view';

import { localizedText } from '../../shared/localization';
import { linesOnScreen, noteLines, shownLines } from './puppetNoteLines';
import { listenersOf } from './puppetListeners';
import { puppetProviders, registeredVerbs } from './puppetRegistry';
import { aimPoint, sectionOf } from './puppetSections';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementRow {
  ref: string;
  component: string | null;
  role: string;
  text: string;
  handlers: string[];
  flags: string[];
  rect: Rect;
  /** The note id (`work/standup`) a sidebar note row stands for: what `OpenNote` and friends take. */
  note?: string;
  /** The folder path a sidebar folder row stands for. */
  folder?: string;
  /** The part of the page it is in: `sidebar · list`, `dialog`, `menu` (puppetSections.ts). */
  section: string;
  /** Where a click reaches it, when that is not its centre (something covers the centre). */
  aim?: { x: number; y: number };
  /** The verb that does what clicking it does (`A|B` when two do), as the verbs claim controls. */
  verb?: string;
}

interface SvelteMeta {
  loc?: { file: string; line: number; column: number };
}

const INTERACTABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="textbox"]',
  '[tabindex]',
].join(',');

// Events Svelte 5 delegates to the root and stores per element under a private
// Symbol('events'); everything else reaches the page through addEventListener,
// which puppetListeners.ts records. `on*` attributes are the third visible kind.
const POINTER_EVENTS = [
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'mousedown',
  'contextmenu',
];
// What an element row lists; `show` lists every registered listener.
const ROW_EVENTS = new Set([...POINTER_EVENTS, 'touchstart', 'keydown']);
/** Svelte 5's root delegator: plumbing, not a handler. The handlers it dispatches to are listed on their elements. */
export const SVELTE_DELEGATOR = 'handle_event_propagation';
const TEXT_LIMIT = 24;

const refByElement = new WeakMap<Element, string>();
// Weak, so a ref never keeps a replaced document's nodes alive. ponytail: a collected element's
// entry stays until its ref is asked for; a FinalizationRegistry would drop it if that grows.
const elementByRef = new Map<string, WeakRef<Element>>();
let nextRef = 1;

export function refOf(element: Element): string {
  let ref = refByElement.get(element);
  if (!ref) {
    ref = `e${nextRef++}`;
    refByElement.set(element, ref);
    elementByRef.set(ref, new WeakRef(element));
  }
  return ref;
}

export function elementForRef(ref: string): Element | null {
  const element = elementByRef.get(ref)?.deref();
  if (!element) elementByRef.delete(ref);
  return element?.isConnected ? element : null;
}

function round(value: number): number {
  return Math.round(value);
}

export function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { x: round(box.left), y: round(box.top), w: round(box.width), h: round(box.height) };
}

type EventTable = Record<string, (...args: unknown[]) => unknown>;

/** Listeners on the editable are ProseMirror's: one name, whatever it bound. */
export function handlerLabel(target: EventTarget, name: string): string {
  return target instanceof Element && target.classList.contains('ProseMirror') ? 'pm' : name;
}

/** Svelte 5's per-element delegated-handler table, live: the trace rewrites entries in it. */
export function svelteEventTable(element: Element): EventTable | null {
  const symbol = Object.getOwnPropertySymbols(element).find(
    (candidate) => candidate.description === 'events',
  );
  const table = symbol ? (element as unknown as Record<symbol, unknown>)[symbol] : null;
  return table && typeof table === 'object' ? (table as EventTable) : null;
}

/**
 * `event=fn` per handler. Listeners on the editable are ProseMirror's and show
 * as `pm`. Default: the events a tap or key would reach.
 */
export function handlersOf(element: Element, options: { all?: boolean } = {}): string[] {
  const handlers = new Set<string>();
  const wanted = (event: string) => options.all || ROW_EVENTS.has(event);
  const registered = (target: Element) => {
    for (const record of listenersOf(target)) {
      if (record.name === SVELTE_DELEGATOR || !wanted(record.type)) continue;
      handlers.add(`${record.type}=${handlerLabel(target, record.name)}`);
    }
  };
  for (const [event, handler] of Object.entries(svelteEventTable(element) ?? {})) {
    if (typeof handler === 'function' && wanted(event))
      handlers.add(`${event}=${handler.name || 'anonymous'}`);
  }
  for (const attribute of element.getAttributeNames()) {
    if (attribute.startsWith('on') && wanted(attribute.slice(2)))
      handlers.add(`${attribute.slice(2)}=inline`);
  }
  registered(element);
  return [...handlers];
}

/** The Svelte component file that rendered this element, from dev-mode metadata. */
export function componentOf(element: Element): string | null {
  let node: Element | null = element;
  while (node) {
    const file = (node as unknown as { __svelte_meta?: SvelteMeta }).__svelte_meta?.loc?.file;
    if (file) return file.slice(file.lastIndexOf('/') + 1);
    node = node.parentElement;
  }
  return null;
}

function isInteractable(element: Element): boolean {
  if (element.classList.contains('ProseMirror')) return true;
  return element.matches(INTERACTABLE_SELECTOR) || handlersOf(element).length > 0;
}

function roleOf(element: Element): string {
  // Before the explicit role: ProseMirror marks its editable `role="textbox"`.
  if (element.classList.contains('ProseMirror')) return 'editor';
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input') return (element as HTMLInputElement).type || 'text';
  const editable = element.getAttribute('contenteditable');
  if (tag === 'textarea' || (editable !== null && editable !== 'false')) return 'textbox';
  return tag;
}

function collapse(text: string | null | undefined): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > TEXT_LIMIT ? `${collapsed.slice(0, TEXT_LIMIT - 1)}…` : collapsed;
}

/** The next node after `walker`'s current one and everything inside it, null past its root. */
function pastSubtree(walker: TreeWalker): Node | null {
  for (let node: Node | null = walker.currentNode; node && node !== walker.root;) {
    const sibling = walker.nextSibling();
    if (sibling) return sibling;
    node = walker.parentNode();
  }
  return null;
}

/**
 * An element holding the editor, as it reads on screen: its own text, with the note's lines
 * on screen standing in for the note, which a person sees only that much of. Read until the
 * label is full, so a long note costs no more than a short one.
 */
function textAroundEditor(element: Element, editorDom: Element, onScreen: () => string): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let text = '';
  let node: Node | null = walker.currentNode;
  while (node && text.trim().length <= TEXT_LIMIT) {
    if (node === editorDom) {
      text += ` ${onScreen()} `;
      node = pastSubtree(walker);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue ?? '';
    node = walker.nextNode();
  }
  return text;
}

/**
 * The lines on screen of an element inside the editor that covers lines off screen, null when
 * every line it covers shows: a code block taller than the screen does not read as its first
 * line, nor an image off screen as its title. ponytail: each element searches for the screen's
 * lines again, so `elements {"all":true}` over a note of many links pays it per link; pass
 * one `linesOnScreen` down from `collectElements` if that shows.
 */
function shownPartOf(element: Element, view: EditorView): string | null {
  const note = noteLines(view.state.doc);
  const covered = note.between(
    view.posAtDOM(element, 0),
    view.posAtDOM(element, element.childNodes.length),
  );
  const onScreen = linesOnScreen(view, note);
  const shown = covered.filter(
    (entry) => onScreen && entry.line >= onScreen.first && entry.line <= onScreen.last,
  );
  return shown.length === covered.length ? null : shown.map((entry) => entry.text).join(' ');
}

function textOf(element: Element): string {
  const view = puppetProviders.editor?.getView();
  const shownPart =
    view && element !== view.dom && view.dom.contains(element) ? shownPartOf(element, view) : null;
  if (shownPart !== null) return collapse(shownPart);
  const labelled = element.getAttribute('aria-label') ?? element.getAttribute('title');
  if (labelled) return collapse(labelled);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return collapse(element.value || element.placeholder);
  }
  if (view && element.contains(view.dom)) {
    return collapse(
      textAroundEditor(element, view.dom, () => {
        const note = noteLines(view.state.doc);
        return shownLines(note, linesOnScreen(view, note))
          .map((entry) => entry.text)
          .join(' ');
      }),
    );
  }
  return collapse(element.textContent);
}

function flagsOf(element: Element): string[] {
  const flags: string[] = [];
  const active = document.activeElement;
  if (active && (active === element || element.contains(active))) flags.push('focused');
  if ((element as HTMLButtonElement).disabled) flags.push('disabled');
  for (const attribute of ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked']) {
    if (element.getAttribute(attribute) === 'true') flags.push(attribute.slice(5));
  }
  if (getComputedStyle(element).pointerEvents === 'none') flags.push('passes');
  return flags;
}

/** The verbs a person can reach, by their controls' labels as they read now and by selector. */
interface VerbClaims {
  byLabel: Map<string, string[]>;
  bySelector: Array<{ selector: string; verb: string }>;
}

function verbClaims(): VerbClaims {
  const claims: VerbClaims = { byLabel: new Map(), bySelector: [] };
  for (const verb of registeredVerbs()) {
    if (verb.controlsMatching) {
      claims.bySelector.push({ selector: verb.controlsMatching, verb: verb.name });
    }
    for (const key of verb.controls ?? []) {
      const label = localizedText(key);
      const verbs = claims.byLabel.get(label) ?? [];
      if (!verbs.includes(verb.name)) claims.byLabel.set(label, [...verbs, verb.name]);
    }
  }
  return claims;
}

/**
 * The verbs a control stands for: those whose label is its text, or leads it (a row's title
 * before its description), the longest such label winning. `just check-puppet-verbs` holds the
 * labels to the controls at build time; this only names them on screen.
 */
export function verbsFor(text: string, byLabel: Map<string, string[]>): string | undefined {
  let best = byLabel.get(text);
  if (!best) {
    let longest = 0;
    for (const [label, verbs] of byLabel) {
      if (label.length > longest && text.startsWith(`${label} `)) {
        best = verbs;
        longest = label.length;
      }
    }
  }
  return best?.join('|');
}

const CONTAINER_ROLES = new Set(['dialog', 'presentation']);

/** A row whose label is the user's own (a note row) is claimed by selector, before any label. */
function verbOf(element: Element, names: Array<string | null>, claims: VerbClaims) {
  const matched = claims.bySelector.filter((claim) => element.matches(claim.selector));
  if (matched.length > 0) return matched.map((claim) => claim.verb).join('|');
  return names.map((name) => (name ? verbsFor(name, claims.byLabel) : undefined)).find(Boolean);
}

export function describeElement(
  element: Element,
  aim: { x: number; y: number } | null = aimPoint(element),
  claims: VerbClaims = verbClaims(),
): ElementRow {
  const rect = rectOf(element);
  const centred =
    !aim ||
    (Math.abs(aim.x - (rect.x + rect.w / 2)) <= 1 && Math.abs(aim.y - (rect.y + rect.h / 2)) <= 1);
  const text = textOf(element);
  const role = roleOf(element);
  // A field reads as its value; what it is called is its label or placeholder.
  const names = [
    text,
    ...['aria-label', 'placeholder', 'title'].map((name) => element.getAttribute(name)),
  ];
  // A dialog and its backdrop hold controls rather than being one: their text opens with the
  // dialog's title ("Delete note"), which is some control's label, not theirs.
  const verb = CONTAINER_ROLES.has(role) ? undefined : verbOf(element, names, claims);
  return {
    ref: refOf(element),
    component: componentOf(element),
    role,
    text,
    handlers: handlersOf(element),
    flags: flagsOf(element),
    rect,
    section: sectionOf(element),
    ...(centred ? {} : { aim }),
    ...identityOf(element),
    ...(verb ? { verb } : {}),
  };
}

function identityOf(element: Element): Pick<ElementRow, 'note' | 'folder'> {
  const note = element.getAttribute('data-note-id');
  // "" is a real path: the root, as a picker's Root row names it.
  const folder = element.getAttribute('data-folder-path');
  return { ...(note ? { note } : {}), ...(folder !== null ? { folder } : {}) };
}

function inViewport(rect: Rect): boolean {
  return rect.x + rect.w > 0 && rect.y + rect.h > 0 && rect.x < innerWidth && rect.y < innerHeight;
}

function isVisible(element: Element, rect: Rect): boolean {
  return rect.w > 0 && rect.h > 0 && getComputedStyle(element).visibility !== 'hidden';
}

/**
 * Interactable elements, front-of-tree order. Default: what a pointer could
 * reach — visible, in the viewport, and not under a dialog, an overlay or a
 * scroll container's clipped edge. `all` adds the rest, each flagged with why a
 * pointer cannot reach it: `hidden`, `offscreen` or `covered`.
 */
export function collectElements(options: { all?: boolean; root?: Element }): ElementRow[] {
  const root = options.root ?? document.body;
  const rows: ElementRow[] = [];
  const claims = verbClaims();
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!isInteractable(element)) continue;
    const rect = rectOf(element);
    const out = !isVisible(element, rect) ? 'hidden' : !inViewport(rect) ? 'offscreen' : null;
    const aim = out ? null : aimPoint(element);
    const unreachable = out ?? (aim ? null : 'covered');
    if (unreachable && !options.all) continue;
    const row = describeElement(element, aim, claims);
    if (unreachable) row.flags.push(unreachable);
    rows.push(row);
  }
  return rows;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * Front-to-back stack at a point. The browser's hit-test omits every
 * `pointer-events: none` element, so those are added back by geometry — the
 * layers that pass a tap through are exactly the ones worth seeing.
 */
export function stackAt(x: number, y: number): ElementRow[] {
  const hit = document.elementsFromPoint?.(x, y) ?? [];
  const seen = new Set<Element>(hit);
  const rows = hit
    .filter((element) => element !== document.documentElement)
    .map((element) => describeElement(element));
  for (const element of document.body.querySelectorAll('*')) {
    if (seen.has(element) || !contains(rectOf(element), x, y)) continue;
    if (getComputedStyle(element).pointerEvents !== 'none') continue;
    rows.push(describeElement(element));
  }
  return rows;
}

/** For each pointer event, the front-most element in the stack that handles it. */
export function ownersOf(stack: ElementRow[]): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const event of POINTER_EVENTS) {
    const owner = stack.find(
      (row) => !row.flags.includes('passes') && row.handlers.some((h) => h.startsWith(`${event}=`)),
    );
    if (owner)
      owners[event] = `${owner.ref} ${owner.handlers.find((h) => h.startsWith(`${event}=`))}`;
  }
  return owners;
}
