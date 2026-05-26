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
 * Monotonic serial. Module-scoped so any two coexisting plugin instances
 * (e.g. brief overlap during a tab switch) can't issue the same serial —
 * the Kotlin side compare-and-sets against highWater, so the later
 * serial always wins on the shadow.
 */
let nextSerial = 0;
function takeSerial(): number {
  nextSerial += 1;
  return nextSerial;
}

export const imeShieldPlugin = ViewPlugin.fromClass(
  class {
    // Per-view dedup cache. Module-level state would let one editor's
    // destroy() clobber another's "last pushed" markers — during tab
    // switches two MarkdownEditor instances can briefly coexist, and
    // their pushes must NOT see each other's shadow.
    lastText = '';
    lastSelStart = -1;
    lastSelEnd = -1;
    lastActive = false;

    push(text: string, selStart: number, selEnd: number): void {
      const bridge = getBridge();
      if (!bridge) return;
      if (
        text === this.lastText &&
        selStart === this.lastSelStart &&
        selEnd === this.lastSelEnd
      ) return;
      this.lastText = text;
      this.lastSelStart = selStart;
      this.lastSelEnd = selEnd;
      try {
        bridge.update(text, selStart, selEnd, takeSerial());
      } catch {
        // Bridge invocations cross JNI. Throwing back into JS is rare
        // but possible (e.g. WebView mid-teardown). Swallow — the next
        // update supersedes.
      }
    }

    setActive(active: boolean): void {
      const bridge = getBridge();
      if (!bridge) return;
      if (active === this.lastActive) return;
      this.lastActive = active;
      try {
        bridge.setActive(active);
      } catch {
        // Same failure mode as push().
      }
    }

    constructor(view: EditorView) {
      // Initial sync so the shadow is correct before the IME first
      // queries it (mount → focus → IME asks within a couple of
      // frames, sometimes before our first update fires).
      const s = view.state;
      this.push(s.doc.toString(), s.selection.main.from, s.selection.main.to);
      if (view.hasFocus) this.setActive(true);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
      const s = update.state;
      this.push(s.doc.toString(), s.selection.main.from, s.selection.main.to);
    }

    destroy() {
      // We can't safely call bridge.reset() here — during a tab switch
      // another live MarkdownEditor's shadow may already own the bridge,
      // and reset would wipe its state. Instead just mark ourselves
      // inactive; the new editor's mount or focus push will overwrite
      // text/selection. If we were the last editor, the IME going
      // active=false is the correct signal that the editable is gone.
      this.setActive(false);
    }
  }
  , {
    eventHandlers: {
      focusin(_event, view) {
        const s = view.state;
        const plugin = view.plugin(imeShieldPlugin);
        if (!plugin) return;
        plugin.push(s.doc.toString(), s.selection.main.from, s.selection.main.to);
        plugin.setActive(true);
      },
      focusout(_event, view) {
        const plugin = view.plugin(imeShieldPlugin);
        plugin?.setActive(false);
      },
    },
  }
);
