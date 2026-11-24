/* What a code line draws besides its text (desktopCodeBlocks.css): its gutter's width; on a
 * block's first line the block's header, a non-editable element first in the line: the name
 * field on the left, its "add a line above" label in the room between, the language field on
 * the right and the copy button after it (codeBlockHeader.ts answers them); and on its last
 * line the zone holding "add a line below" (codeBlockEdges.ts), after the header if the line
 * has one. This chrome holds no text node, only inputs, a button and attributes CSS draws
 * from, so the line's text, the offsets read from the page (lineElements.ts `offsetOf`,
 * `pointInLine`) and the engine's stay one. */
import { localizedText } from '$shared/localization';
import type { Line } from './lineModel';
import { setDrawnAttribute } from './atomElements';
import { buildEdgeLabel, drawEdgeBelow, isCodeEdgeBelow } from './codeBlockEdges';

const CODE_HEADER_CLASS = 'code-header';
const CODE_NAME_CLASS = 'code-name';
export const CODE_LANGUAGE_CLASS = 'code-language';
const CODE_COPY_CLASS = 'code-copy';

const GUTTER_DIGITS = '--code-digits';

export function isCodeHeader(node: Node | null): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(CODE_HEADER_CLASS);
}

/** The code block header `node` is in or is, or null. */
export function codeHeaderOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(`.${CODE_HEADER_CLASS}`) ?? null;
}

export function isInCodeHeader(node: Node | null): boolean {
  return codeHeaderOf(node) !== null;
}

/** Whether `target` is one of a header's fields or its copy button: their events are the
 *  header's, not the note's. */
export function isCodeHeaderControl(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) &&
    isInCodeHeader(target)
  );
}

/** A header's name field, its language field and its copy button. */
export function codeHeaderControls(header: HTMLElement): {
  name: HTMLInputElement;
  language: HTMLInputElement;
  copy: HTMLButtonElement;
} {
  return {
    name: header.querySelector<HTMLInputElement>(`.${CODE_NAME_CLASS}`)!,
    language: header.querySelector<HTMLInputElement>(`.${CODE_LANGUAGE_CLASS}`)!,
    copy: header.querySelector<HTMLButtonElement>(`.${CODE_COPY_CLASS}`)!,
  };
}

/** Whether `node` is a code line's chrome: its header or the zone below its block. */
export function isCodeChrome(node: Node | null): node is HTMLElement {
  return isCodeHeader(node) || isCodeEdgeBelow(node);
}

/** The chrome nodes that start a code line element: none, its header, the zone below its block
 *  or both. */
export function codeChromeCount(element: HTMLElement): number {
  let count = 0;
  for (let node = element.firstChild; isCodeChrome(node); node = node.nextSibling) count++;
  return count;
}

/** What a piece of chrome draws from its line, as Puppet's drift check compares it: a header's
 *  name and language. Its fields' focus, the copy button's copied flash, the caret's block and
 *  a label the pointer shows are not drawn from the line. */
export function drawnCodeChrome(chrome: Element): string {
  if (!isCodeHeader(chrome)) return chrome.className;
  return JSON.stringify([chrome.getAttribute('data-name'), chrome.getAttribute('data-language')]);
}

/** A field sized by an invisible copy of its value (`data-value`), so the box is its own text
 *  plus a collar however long the value grows. */
function buildField(inputClass: string, fieldClass: string, placeholder: string): HTMLElement {
  const input = document.createElement('input');
  input.className = inputClass;
  input.type = 'text';
  input.size = 1;
  input.tabIndex = -1;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.placeholder = placeholder;
  const field = document.createElement('span');
  field.className = `code-field ${fieldClass}`;
  field.append(input);
  return field;
}

function buildCodeHeader(): HTMLElement {
  const header = document.createElement('span');
  header.className = CODE_HEADER_CLASS;
  header.setAttribute('contenteditable', 'false');
  const name = buildField(
    CODE_NAME_CLASS,
    'code-name-field',
    localizedText('editor.codeBlock.namePlaceholder'),
  );
  const space = document.createElement('span');
  space.className = 'code-header-space';
  space.append(buildEdgeLabel(false));
  const language = buildField(
    CODE_LANGUAGE_CLASS,
    'code-language-field',
    localizedText('editor.codeBlock.languagePlaceholder'),
  );
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.tabIndex = -1;
  copy.className = CODE_COPY_CLASS;
  copy.title = localizedText('editor.codeBlock.copyTitle');
  header.append(name, space, language, copy);
  return header;
}

/** Size `input`'s field to its value, or its placeholder while empty. */
export function sizeCodeField(input: HTMLInputElement): void {
  input.parentElement?.setAttribute('data-value', input.value || input.placeholder);
}

/** Show the header's drawn name and language in its fields; a focused field keeps what is
 *  being typed in it. */
export function showCodeHeaderValues(header: HTMLElement): void {
  const name = header.getAttribute('data-name') ?? '';
  const language = header.getAttribute('data-language') ?? '';
  const controls = codeHeaderControls(header);
  for (const [input, value] of [
    [controls.name, name],
    [controls.language, language],
  ] as const) {
    if (document.activeElement !== input && input.value !== value) input.value = value;
    sizeCodeField(input);
  }
}

/** Draw `line`'s gutter width, header and zone below its block into `element`; returns the last
 *  of them, which the line's text is drawn after, or null on a line without either. */
export function drawCodeChrome(element: HTMLElement, line: Line): HTMLElement | null {
  const code = line.code;
  const digits = code && code.digits > 2 ? String(code.digits) : '';
  if (element.style.getPropertyValue(GUTTER_DIGITS) !== digits) {
    if (digits) element.style.setProperty(GUTTER_DIGITS, digits);
    else element.style.removeProperty(GUTTER_DIGITS);
  }
  const header = drawCodeHeader(element, line);
  return drawEdgeBelow(element, !!code?.last, header) ?? header;
}

/** Draw `line`'s header into `element`, its first child; returns it, or null on a line that is
 *  not its block's first. */
function drawCodeHeader(element: HTMLElement, line: Line): HTMLElement | null {
  const code = line.code;
  let header = isCodeHeader(element.firstChild) ? element.firstChild : null;
  if (!code?.first) {
    header?.remove();
    return null;
  }
  const created = !header;
  header ??= buildCodeHeader();
  if (created) element.prepend(header);
  const name = code.name ?? '';
  const language = code.language ?? '';
  const changed =
    header.getAttribute('data-name') !== name || header.getAttribute('data-language') !== language;
  // Never removed, so the two keep their order and a header draws alike however it was reached.
  setDrawnAttribute(header, 'data-name', name);
  setDrawnAttribute(header, 'data-language', language);
  if (created || changed) showCodeHeaderValues(header);
  return header;
}
