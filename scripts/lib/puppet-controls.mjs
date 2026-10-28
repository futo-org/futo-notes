// What each control on screen is labelled, and which verb claims it, read from source for
// check-puppet-verbs.mjs. A verb names the catalog keys of its controls' labels (`controls`),
// so the gate can hold every labelled control to a verb and every verb to a control without
// running anything. Svelte is parsed; Kotlin and SwiftUI are read by bracket matching over
// code with strings and comments masked, which is enough for the shapes the app writes.
import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'svelte/compiler';

import { flattenMessages } from '../language-catalogs.mjs';

/**
 * The catalog's messages by dotted key (`editor.find.close`), each with whether it takes
 * arguments (`Remove tag {tagName}`), which make it read differently on every row.
 */
export function catalogKeys(root) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'languages/en.json'), 'utf8'));
  const messages = flattenMessages(catalog.messages, 'en.json', []);
  return new Map(
    [...messages].map(([key, message]) => [key, { templated: message.placeholders.size > 0 }]),
  );
}

/**
 * The source with every string's contents and every comment blanked to the same length, so
 * brackets and patterns match code only and offsets still point into the original.
 */
export function maskCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : next === '/' ? close : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const triple = c === '"' && source.startsWith('"""', i);
      const quote = triple ? '"""' : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) j += source[j] === '\\' ? 2 : 1;
      j = Math.min(source.length, j + quote.length);
      out +=
        quote + source.slice(i + quote.length, j - quote.length).replace(/[^\n]/g, '_') + quote;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CLOSING = { '(': ')', '{': '}', '[': ']' };

/** The index of the bracket that closes the one at `open`, or -1. */
function matchClose(code, open) {
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c in CLOSING) stack.push(CLOSING[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The unmatched `(` a position sits inside: the argument list of the call it belongs to. */
function openingParen(code, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return c === '(' ? i : -1;
      depth--;
    }
  }
  return -1;
}

/** Past a call's closing paren: its trailing lambdas, `{ … }` and Swift's `label: { … }`. */
function throughTrailingLambdas(code, end) {
  for (;;) {
    const lambda = code.slice(end + 1).match(/^\s*(?:\w+:\s*)?\{/);
    if (!lambda) return end;
    const close = matchClose(code, end + lambda[0].length);
    if (close < 0) return end;
    end = close;
  }
}

/** Past a SwiftUI view's modifier chain: `.accessibilityLabel(…)`, `.tint(…)`, … */
function throughModifiers(code, end) {
  for (;;) {
    const modifier = code.slice(end + 1).match(/^\s*\.\w+\(/);
    if (!modifier) return end;
    const close = matchClose(code, end + modifier[0].length);
    if (close < 0) return end;
    end = throughTrailingLambdas(code, close);
  }
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/**
 * The catalog keys a text passes to `localizedText(…)`: every dotted string literal in the
 * call's arguments, so `localizedText(if (sending) "feedback.sending" else "common.actions.send")`
 * reads as both. An argument map's names (`"name" to …`) have no dot and are not keys.
 */
function keysIn(text) {
  const keys = new Set();
  for (const call of text.matchAll(/localizedText\(/g)) {
    let depth = 1;
    let end = call.index + call[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')') depth--;
      end++;
    }
    const argumentsText = text.slice(call.index + call[0].length, end - 1);
    for (const literal of argumentsText.matchAll(/["']([A-Za-z]\w*(?:\.\w+)+)["']/g))
      keys.add(literal[1]);
  }
  return [...keys];
}

/** A span's text with the spans of the controls nested in it blanked: their labels are theirs. */
function ownText(source, span, spans) {
  let text = source.slice(span.start, span.end + 1);
  for (const inner of spans) {
    if (inner === span || inner.start <= span.start || inner.end > span.end) continue;
    const from = inner.start - span.start;
    const to = inner.end - span.start + 1;
    text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
  }
  return text;
}

// A callback that is not one (`onCheckedChange = null`: the row around it takes the touch).
export const KOTLIN_HANDLER =
  /\b(onClick|onLongClick|onValueChange|onCheckedChange|onSelect|onTyped)\s*=(?!\s*null\b)|\.(clickable|combinedClickable|toggleable|selectable)\b/g;
export const SWIFT_CONTROL =
  /\b(?:Button|Toggle|Picker|TextField|SecureField|Menu|ShareLink|NavigationLink|DisclosureGroup)\s*[({]/g;
const SWIFT_ACCESSIBILITY_LABEL = /\.accessibilityLabel\(\s*(?:\w+\.)*localizedText\([^)]*\)/g;

/**
 * `onClick = {}`, `.clickable {}`, `.clickable(onClick = {})`: a handler that only swallows a
 * tap so it goes no further (an overlay's), and does nothing.
 */
function inertHandler(code, at, assigned) {
  const empty = (from) => /^\s*\{\s*\}/.test(code.slice(from));
  if (assigned) return empty(at);
  let end = at;
  const open = code.slice(at).match(/^\s*\(/);
  if (open) {
    const close = matchClose(code, at + open[0].length - 1);
    const args = code.slice(at + open[0].length, close);
    if (/\bonClick\s*=\s*\{\s*\}/.test(args)) return true;
    if (/\bonClick\s*=/.test(args)) return false;
    end = close + 1;
  }
  return empty(end);
}

/**
 * The controls in a Kotlin or Swift file: where each is, and the catalog keys it is labelled
 * with (empty when the label is computed). A Compose callback that only hands on its
 * caller's (`onClick = onClick`) with no label of its own is the caller's control, and the
 * caller's call site is where it is counted.
 */
export function nativeControls(source, language) {
  const code = maskCode(source).replace(/^import .*$/gm, (line) => ' '.repeat(line.length));
  const spans = [];
  if (language === 'kotlin') {
    for (const match of code.matchAll(KOTLIN_HANDLER)) {
      const open = openingParen(code, match.index);
      if (open < 0) continue;
      let start = open;
      while (start > 0 && /[\w.]/.test(code[start - 1])) start--;
      if (spans.some((span) => span.start === start)) continue;
      const at = match.index + match[0].length;
      const after = code.slice(at);
      // `onClick = onClick`, `.clickable(onClick = onClick)`: the caller's handler, handed on.
      const forwarded =
        match[1] !== undefined
          ? /^\s*\w+\s*[,)\n]/.test(after)
          : /^\s*\((?:[^(){}]*,)?\s*(?:onClick|onValueChange)\s*=\s*\w+\s*[,)]/.test(after);
      if (inertHandler(code, at, match[1] !== undefined)) continue;
      spans.push({ start, end: throughTrailingLambdas(code, matchClose(code, open)), forwarded });
    }
  } else {
    for (const match of code.matchAll(SWIFT_CONTROL)) {
      const close = matchClose(code, match.index + match[0].length - 1);
      if (close < 0) continue;
      spans.push({
        start: match.index,
        end: throughModifiers(code, throughTrailingLambdas(code, close)),
      });
    }
  }
  const controls = [];
  for (const span of spans) {
    const text = ownText(source, span, spans);
    // An accessibility label is what VoiceOver and the reader see, over any text inside.
    const labelled =
      language === 'swift'
        ? [...text.matchAll(SWIFT_ACCESSIBILITY_LABEL)].flatMap((label) => keysIn(label[0] + ')'))
        : [];
    const keys = labelled.length > 0 ? labelled : keysIn(text);
    if (keys.length === 0 && span.forwarded) continue;
    controls.push({ line: lineOf(source, span.start), keys });
  }
  return controls;
}

/** The DOM events a control is wired with: a Svelte attribute, an addEventListener, an `el.onX =`. */
export const DOM_EVENTS =
  'click|dblclick|auxclick|mousedown|mouseup|input|change|submit|contextmenu|keydown|keyup|pointerdown|pointerup|touchstart|touchend|blur|focus|dragstart|dragover|dragend|drop|paste|copy|cut|wheel';
const DOM_EVENT = new RegExp(`^on(?:${DOM_EVENTS})$`);

/**
 * The controls in a Svelte component: each element given a DOM event handler, and the
 * catalog keys of its label: its `aria-label`, `title`, `placeholder` or `label`, else, for
 * an element whose content is its label (a button, a link, a field, a menu item), its own
 * content, not a nested control's. A container that handles an event for what is inside it
 * (a backdrop, a drop zone) is labelled only by an attribute. A component handed a handler
 * and no label is its own file's control, counted there. A menu entry handed to a shared
 * menu as data (`{ label: { path: 'notes.actions.copyFilePath' }, onclick }`, which
 * DropdownMenu.svelte draws) is a control of the file that names it.
 */
export function svelteControls(source) {
  const controls = [];
  const ast = parse(source, { modern: true });
  const labelFor = labelsById(source, ast.fragment);
  // A field inside a <label> is labelled by the label's text, as HTML associates them.
  const visit = (node, wrapping = []) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, wrapping));
    if (node.type === 'RegularElement' && node.name === 'label') {
      wrapping = ownContentKeys(source, node.fragment);
    }
    if (isControl(node, source)) {
      const labelled = ['aria-label', 'title', 'placeholder', 'label'];
      const attributes = node.attributes
        .filter((attribute) => attribute.type === 'Attribute' && !DOM_EVENT.test(attribute.name))
        .sort((a, b) => rank(labelled, a.name) - rank(labelled, b.name));
      let keys = [];
      for (const attribute of attributes) {
        // A component's `title` is a dialog's heading, not what the control is called.
        const label =
          node.type === 'Component'
            ? attribute.name !== 'title'
            : labelled.includes(attribute.name);
        if (!label) continue;
        keys = keysIn(source.slice(attribute.start, attribute.end));
        if (keys.length > 0) break;
      }
      if (keys.length === 0 && labelledByContent(node))
        keys = ownContentKeys(source, node.fragment);
      if (keys.length === 0) keys = labelFor.get(staticAttribute(node, 'id')) ?? wrapping;
      if (keys.length > 0 || node.type === 'RegularElement') {
        controls.push({ line: lineOf(source, node.start), keys });
      }
    }
    for (const [name, value] of Object.entries(node)) {
      if (name !== 'parent' && value && typeof value === 'object') visit(value, wrapping);
    }
  };
  visit(ast.fragment);
  for (const entry of source.matchAll(MENU_ENTRY)) {
    controls.push({ line: lineOf(source, entry.index), keys: [entry[1]] });
  }
  return controls;
}

const MENU_ENTRY = /label:\s*\{\s*path:\s*'([a-z][\w.]*)'\s*\},\s*onclick:/g;

/** An attribute's value when it is plain text (`id="sync-url"`), else undefined. */
function staticAttribute(node, name) {
  const value = node.attributes?.find((attribute) => attribute.name === name)?.value;
  return Array.isArray(value) && value.length === 1 && value[0].type === 'Text'
    ? value[0].data
    : undefined;
}

/** `<label for="sync-url">` text by the id it names: the field with that id is labelled by it. */
function labelsById(source, fragment) {
  const labels = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const target =
      node.type === 'RegularElement' && node.name === 'label' && staticAttribute(node, 'for');
    if (target) labels.set(target, ownContentKeys(source, node.fragment));
    for (const [name, value] of Object.entries(node)) {
      if (name !== 'parent' && value && typeof value === 'object') visit(value);
    }
  };
  visit(fragment);
  return labels;
}

const CONTENT_LABELLED = new Set([
  'button',
  'a',
  'label',
  'option',
  'summary',
  'input',
  'textarea',
  'select',
]);
const CONTROL_ROLES = /^(?:button|menuitem|tab|option|checkbox|switch|link|radio)$/;

function labelledByContent(node) {
  if (node.type !== 'RegularElement') return true;
  if (CONTENT_LABELLED.has(node.name)) return true;
  const role = node.attributes.find((attribute) => attribute.name === 'role');
  const value = role?.value?.[0]?.data;
  return typeof value === 'string' && CONTROL_ROLES.test(value);
}

// `onclick={(event) => event.stopPropagation()}`: keeps a click from its container, does nothing.
const INERT_HANDLER =
  /^\{\s*\(?\s*\w*\s*\)?\s*=>\s*\w+\.(?:stopPropagation|preventDefault)\(\)\s*;?\s*\}$/;

// `bind:value` on a field is input as much as `oninput` is.
const INPUT_BINDINGS = new Set(['value', 'checked', 'group', 'files']);

function isControl(node, source) {
  if (node.type !== 'RegularElement' && node.type !== 'Component') return false;
  const bound = (node.attributes ?? []).some(
    (attribute) => attribute.type === 'BindDirective' && INPUT_BINDINGS.has(attribute.name),
  );
  if (bound && node.type === 'RegularElement') return true;
  const handlers = (node.attributes ?? []).filter(
    (attribute) => attribute.type === 'Attribute' && DOM_EVENT.test(attribute.name),
  );
  if (handlers.length === 0) return false;
  if (source === undefined) return true;
  return handlers.some((attribute) => {
    const text = source.slice(attribute.start, attribute.end).replace(/^\w+=/, '');
    return !INERT_HANDLER.test(text);
  });
}

function rank(order, name) {
  const index = order.indexOf(name);
  return index < 0 ? order.length : index;
}

/** The catalog keys in a control's own content, not counting a nested control's. */
function ownContentKeys(source, fragment) {
  const keys = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (isControl(node)) return;
    if (node.type === 'ExpressionTag' || node.type === 'Attribute' || node.type === 'Text') {
      for (const key of keysIn(source.slice(node.start, node.end))) keys.add(key);
      return;
    }
    for (const [name, value] of Object.entries(node)) {
      if (name !== 'parent' && value && typeof value === 'object') visit(value);
    }
  };
  visit(fragment);
  return [...keys];
}

const DECLARATIONS = {
  ts: { call: /\bpuppetVerb\(\s*'(\w+)'/g, controls: /\bcontrols:\s*\[([^\]]*)\]/ },
  kotlin: { call: /\bPuppetVerb\(\s*"(\w+)"/g, controls: /\bcontrols\s*=\s*listOf\(([^)]*)\)/ },
  swift: { call: /\bVerb\(\s*"(\w+)"/g, controls: /\bcontrols:\s*\[([^\]]*)\]/ },
};

/**
 * Every verb a file declares, with the catalog keys of the controls it claims: `puppetVerb(…,
 * { controls: [...] })`, `PuppetVerb(…, controls = listOf(…))`, `PuppetVerbs.Verb(…, controls:
 * [...])`.
 */
export function verbDeclarations(source, language) {
  const { call, controls } = DECLARATIONS[language];
  const code = maskCode(source);
  const verbs = [];
  for (const match of source.matchAll(call)) {
    const open = source.indexOf('(', match.index);
    const close = matchClose(code, open);
    const span = source.slice(open, close + 1);
    const listed = span.match(controls)?.[1] ?? '';
    verbs.push({
      name: match[1],
      line: lineOf(source, match.index),
      controls: [...listed.matchAll(/['"]([\w.]+)['"]/g)].map((key) => key[1]),
      convenience: /\bconvenience\s*[:=]\s*true\b/.test(span),
    });
  }
  return verbs;
}

/**
 * A listener's own verbs (the shell's: navigation, the list's rows, Settings) and their
 * controls, from the table beside their names: Kotlin `"OpenSettings" to listOf("…")`, Swift
 * `"OpenSettings": ["…"]`, inside the one declaration named `nativeControls`.
 */
export function nativeControlTable(source) {
  const code = maskCode(source);
  const declared = code.match(/\bnativeControls\b[^=]*=/);
  if (!declared) return [];
  const at = declared.index + declared[0].length;
  const open = code.slice(at).search(/[([]/) + at;
  const close = matchClose(code, open);
  const table = source.slice(open, close + 1);
  const entries = [];
  for (const entry of table.matchAll(
    /"(\w+)"\s*(?:to\s+(?:listOf\(|emptyList\()|:\s*\[)([^)\]]*)[)\]]/g,
  )) {
    entries.push({
      name: entry[1],
      line: lineOf(source, open + entry.index),
      controls: [...entry[2].matchAll(/"([\w.]+)"/g)].map((key) => key[1]),
      convenience: false,
    });
  }
  return entries;
}
