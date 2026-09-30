/**
 * Well-formed UTF-16: no lone surrogate (RC-48, maintainer decision 16A).
 *
 * A JavaScript string may hold an unpaired surrogate; a file, a JSON payload
 * bound for serde, and a native string bridge may not. The Tauri postMessage
 * IPC (the only transport WebKitGTK gets) drops the reply to a message whose
 * JSON carries a `\ud800` escape, so the save that sent it never settled. Every
 * text that leaves the editor toward disk or a host is therefore made
 * well-formed first, each lone surrogate becoming U+FFFD. A valid pair
 * (an emoji) is never touched.
 *
 * `String.prototype.toWellFormed` is Chromium 111 / Safari 16.4; the Android
 * WebView floor is Chromium 80 and iOS 15 has no copy, so the method is used
 * where it exists and a scan stands in where it does not. The scan is not a
 * regular expression: lookbehind (needed to spot a lone LOW surrogate) is
 * Safari 16.4+ too.
 */

const ANY_SURROGATE = /[\uD800-\uDFFF]/;

type WellFormedString = string & { toWellFormed?: () => string };

function scanWellFormed(text: string): string {
  let out = '';
  let copiedTo = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    }
    out += text.slice(copiedTo, i) + '\uFFFD';
    copiedTo = i + 1;
  }
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

/** `text` with every lone surrogate replaced by U+FFFD; the same string when it is already well-formed. */
export function toWellFormedText(text: string): string {
  // Nearly every note has no surrogate at all: one native scan and out.
  if (!ANY_SURROGATE.test(text)) return text;
  const native = (text as WellFormedString).toWellFormed;
  if (typeof native === 'function') return native.call(text);
  return scanWellFormed(text);
}

/** Does `text` hold an unpaired surrogate? */
export function hasLoneSurrogate(text: string): boolean {
  return toWellFormedText(text) !== text;
}

/**
 * `value` with every string in it, keys included, made well-formed. The same
 * object comes back when nothing needed changing, so a payload that was already
 * fine costs a walk and no allocation.
 */
export function toWellFormedDeep<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return toWellFormedText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const fixed = walk(value[i]);
      if (fixed !== value[i]) {
        copy ??= value.slice();
        copy[i] = fixed;
      }
    }
    return copy ?? value;
  }
  // Only plain data is walked: bytes, a Map and a class instance serialize by
  // their own rules and hold no string to repair.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const fixedKey = toWellFormedText(key);
    const fixed = walk(record[key]);
    if (fixedKey === key && fixed === record[key] && copy === null) continue;
    if (copy === null) {
      copy = {};
      for (const earlier of Object.keys(record)) {
        if (earlier === key) break;
        copy[earlier] = record[earlier];
      }
    }
    copy[fixedKey] = fixed;
  }
  return copy ?? value;
}
