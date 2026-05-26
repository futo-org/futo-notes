/**
 * IME Shield (JS side).
 *
 * Pushes CM6's current doc text + selection into a Kotlin-side shadow
 * (EditorImeShield) that the Android InputConnection wrapper
 * (FutoImeConnection) reads from instead of round-tripping to
 * Chromium's renderer.
 *
 * Why: see `docs/learnings/ime-shield-workaround.md`. DO NOT REMOVE the
 * `imeShieldPlugin` import / extension wire-up in MarkdownEditor.svelte
 * without reading that doc — pulling this plugin re-opens the
 * FUTO-Keyboard + empty-note + backspace renderer crash.
 *
 * Mechanism:
 *   - The Kotlin side exposes `window.__FutoImeShield__` via
 *     `WebView.addJavascriptInterface` (see
 *     MainActivity.onWebViewCreate).
 *   - On every CM6 update with `docChanged || selectionSet`, we call
 *     `update(text, selStart, selEnd, serial)`. The bridge call is
 *     synchronous from JS's perspective and the Kotlin side stores
 *     the values in @Volatile fields.
 *   - When the IME later asks the InputConnection for surrounding
 *     text, the wrapper serves from the shadow — never round-trips
 *     to the renderer's broken empty-doc handler.
 *
 * No-op on every platform except Android (the bridge object only
 * exists there). The plugin still installs on desktop/iOS so the
 * editor extensions list stays platform-agnostic — it just runs
 * `if (bridge) bridge.update(...)`, which short-circuits when bridge
 * is undefined.
 */

import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';

interface FutoImeShieldBridge {
  update(text: string, selStart: number, selEnd: number, serial: number): void;
  setActive(active: boolean): void;
  reset(): void;
  debugSummary(): string;
}

declare global {
  interface Window {
    __FutoImeShield__?: FutoImeShieldBridge;
  }
}

function getBridge(): FutoImeShieldBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.__FutoImeShield__;
}

/**
 * Monotonic serial. Shared across editor instances — the Kotlin side
 * ignores stale serials, so even if two editors briefly coexist (route
 * transition), the later one wins.
 */
let serial = 0;

/**
 * Last values we pushed. Skip redundant updates so we don't thrash the
 * JNI bridge on every cursor blink / focus change.
 */
let lastText = '';
let lastSelStart = -1;
let lastSelEnd = -1;
let lastActive = false;

function push(text: string, selStart: number, selEnd: number): void {
  const bridge = getBridge();
  if (!bridge) return;
  if (text === lastText && selStart === lastSelStart && selEnd === lastSelEnd) return;
  serial += 1;
  lastText = text;
  lastSelStart = selStart;
  lastSelEnd = selEnd;
  try {
    bridge.update(text, selStart, selEnd, serial);
  } catch {
    // Bridge invocations cross JNI. Throwing back into JS is rare but
    // possible (e.g., the WebView is mid-teardown). Swallow — a missed
    // update just means the next one supersedes.
  }
}

// Convenience: skip the full-doc `doc.toString()` allocation when there
// is no bridge (iOS / desktop / web). The plugin runs on every platform
// so callers don't branch on isAndroid, but `doc.toString()` on a long
// note is O(N) and was being thrown away on those platforms.
function pushFromView(view: EditorView): void {
  if (!getBridge()) return;
  const s = view.state;
  push(s.doc.toString(), s.selection.main.from, s.selection.main.to);
}

function setActive(active: boolean): void {
  const bridge = getBridge();
  if (!bridge) return;
  if (active === lastActive) return;
  lastActive = active;
  try {
    bridge.setActive(active);
  } catch {
    // Same failure mode as update(): during WebView teardown the JNI
    // bridge can disappear. The next focus/update supersedes this.
  }
}

export const imeShieldPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // Initial sync so the shadow is correct before the IME first
      // queries it (mount → focus → IME asks within a couple of
      // frames, sometimes before our first update fires).
      pushFromView(view);
      if (view.hasFocus) setActive(true);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
      pushFromView(update.view);
    }

    destroy() {
      // Tell the shadow the editable is gone. Next focus into a new
      // editable will push again.
      const bridge = getBridge();
      if (bridge) {
        try { bridge.reset(); } catch { /* see push() */ }
      }
      lastActive = false;
      lastText = '';
      lastSelStart = -1;
      lastSelEnd = -1;
    }
  }
  , {
    eventHandlers: {
      focusin(_event, view) {
        pushFromView(view);
        setActive(true);
      },
      focusout() {
        setActive(false);
      },
    },
  }
);
