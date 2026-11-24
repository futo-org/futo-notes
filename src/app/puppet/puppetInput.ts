// Input as a person's arrives: key chords as a keyboard names them, and the clipboard, delivered
// as the DOM events the editor listens for, so its own copy and paste handlers decide what is
// taken and what lands. The desktop editor's keys and typing are puppetTextKeys.ts.
import { isImageFilename } from '$shared/media/imageFiles';

const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

const FUNCTION_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`);

/** The named keys a keyboard has. Any single character is a key too. */
const NAMED_KEYS: readonly string[] = [
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  ...FUNCTION_KEYS,
];

interface KeyChord {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * `Enter`, `a`, `Shift-Tab`, `Mod-b`, `Mod-Shift-z`: `Mod` being Cmd on Apple platforms and
 * Ctrl elsewhere. A string, or why it names no key.
 */
export function parseChord(spec: string): KeyChord | string {
  const parts = spec.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  const chord = plainChord(key);
  for (const modifier of parts) {
    if (modifier === 'Mod') chord[MAC ? 'meta' : 'ctrl'] = true;
    else if (modifier === 'Shift') chord.shift = true;
    else if (modifier === 'Alt' || modifier === 'Option') chord.alt = true;
    else if (modifier === 'Ctrl' || modifier === 'Control') chord.ctrl = true;
    else if (modifier === 'Meta' || modifier === 'Cmd') chord.meta = true;
    else
      return `no modifier key called ${JSON.stringify(modifier)} — Mod, Shift, Alt, Ctrl or Meta`;
  }
  if ([...key].length !== 1 && !NAMED_KEYS.includes(key)) {
    return `no keyboard has a key called ${JSON.stringify(key)} — one character, or ${NAMED_KEYS.join(', ')}`;
  }
  // Shift on a letter is the capital, as a keyboard reports it.
  if (chord.shift && /^[a-z]$/.test(key)) chord.key = key.toUpperCase();
  return chord;
}

function plainChord(key: string): KeyChord {
  return { key, shift: false, alt: false, ctrl: false, meta: false };
}

/** What the agent last copied: the copy handler's own two flavours, as a clipboard holds them. */
export interface PuppetClipboardContent {
  text: string;
  html: string;
  /** A PNG's bytes in base64, as a screenshot or an app's Copy Image puts one there. */
  image?: string;
}

/** `base64`'s bytes as a file named `name`: an image's typed by its extension, any other
 *  file untyped, as a file manager's drag often leaves one. */
export function puppetFile(name: string, base64: string): File {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const type = isImageFilename(name) ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
  return new File([bytes], name, { type });
}

function transfer(): DataTransfer {
  if (typeof DataTransfer === 'function') return new DataTransfer();
  // No DataTransfer constructor (jsdom): the part of one the editor's handlers read.
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => void data.set(type, value),
    clearData: () => data.clear(),
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

/** A clipboard event over `data`, dispatched where the browser dispatches one: the editable. */
function clipboardEvent(
  view: { dom: HTMLElement },
  type: 'copy' | 'cut' | 'paste',
  data: DataTransfer,
) {
  const init = { bubbles: true, cancelable: true };
  const event =
    typeof ClipboardEvent === 'function'
      ? new ClipboardEvent(type, { ...init, clipboardData: data })
      : new Event(type, init);
  if ((event as ClipboardEvent).clipboardData !== data) {
    Object.defineProperty(event, 'clipboardData', { value: data });
  }
  view.dom.dispatchEvent(event);
  return event;
}

/** Copy or cut the selection through the editor's own copy handler. Null when nothing is selected. */
export function copySelection(
  view: { dom: HTMLElement },
  cut: boolean,
): PuppetClipboardContent | null {
  const data = transfer();
  clipboardEvent(view, cut ? 'cut' : 'copy', data);
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  return text === '' && html === '' ? null : { text, html };
}

/** Paste `content` at the selection through the editor's paste pipeline (either editor's). */
export function paste(view: { dom: HTMLElement }, content: PuppetClipboardContent): void {
  const data = transfer();
  if (content.html) data.setData('text/html', content.html);
  if (content.text || !content.image) data.setData('text/plain', content.text);
  if (content.image) data.items.add(puppetFile('image.png', content.image));
  clipboardEvent(view, 'paste', data);
}

/** The agent's own clipboard, never the OS one: what Copy and Cut fill and Paste reads. */
export interface ClipboardAccess {
  content(): PuppetClipboardContent | null;
  copied(content: PuppetClipboardContent | null): void;
}
