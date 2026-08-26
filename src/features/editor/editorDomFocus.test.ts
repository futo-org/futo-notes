// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editorHasDomFocus, type EditorFocusProbe } from './editorDomFocus';

interface Fixture {
  probe: EditorFocusProbe;
  widget: HTMLElement;
  outside: HTMLElement;
}

function fixture(hasFocus: boolean): Fixture {
  const dom = document.createElement('div');
  const contentDOM = document.createElement('div');
  const widget = document.createElement('input');
  const outside = document.createElement('input');
  dom.append(contentDOM, widget);
  document.body.append(dom, outside);
  return { probe: { hasFocus, contentDOM, dom }, widget, outside };
}

/** jsdom always reports a focused document; the interesting cases do not. */
function withDocumentFocus(hasFocus: boolean): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(hasFocus);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('editorHasDomFocus', () => {
  it('reports focus while CodeMirror itself holds it', () => {
    const { probe } = fixture(true);
    withDocumentFocus(true);
    expect(editorHasDomFocus(probe, false)).toBe(true);
  });

  // The regression: an Android WebView blurs the page (Back dismissing the IME,
  // or the native inline-title field taking over) and CodeMirror's
  // `focusChanged` fires while `document.activeElement` is still the content
  // DOM. Reading that as "still focused" meant the shell never saw a blur edge,
  // so a deferred open-note adoption never settled and the editor sat on
  // superseded peer content indefinitely (docs/spec/sync.md — DeferAdopt).
  it('reports blur when the document lost focus with activeElement left behind', () => {
    const { probe } = fixture(false);
    probe.contentDOM.setAttribute('tabindex', '0');
    (probe.contentDOM as HTMLElement).focus();
    withDocumentFocus(false);
    expect(document.activeElement).toBe(probe.contentDOM);
    expect(editorHasDomFocus(probe, false)).toBe(false);
  });

  // The reason the lenient arm exists at all: WKWebView reports a blurred
  // document while the contenteditable really is focused and the keyboard is
  // up (commit 52c174cf1, "Restore mobile keyboard toolbar").
  it('keeps reporting focus on iOS when only the document lost focus', () => {
    const { probe } = fixture(false);
    probe.contentDOM.setAttribute('tabindex', '0');
    (probe.contentDOM as HTMLElement).focus();
    withDocumentFocus(false);
    expect(editorHasDomFocus(probe, true)).toBe(true);
  });

  it('keeps reporting focus for a widget inside the editor', () => {
    const { probe, widget } = fixture(false);
    widget.focus();
    withDocumentFocus(true);
    expect(editorHasDomFocus(probe, false)).toBe(true);
  });

  it('reports find-panel focus as body blur so native formatting chrome hides', () => {
    const { probe, widget } = fixture(false);
    widget.dataset.editorBodyFocus = 'false';
    widget.focus();
    withDocumentFocus(false);
    expect(editorHasDomFocus(probe, true)).toBe(false);
  });

  it('reports blur for an editor widget once the document lost focus', () => {
    const { probe, widget } = fixture(false);
    widget.focus();
    withDocumentFocus(false);
    expect(editorHasDomFocus(probe, false)).toBe(false);
  });

  it('reports blur when focus moved outside the editor', () => {
    const { probe, outside } = fixture(false);
    outside.focus();
    withDocumentFocus(true);
    expect(editorHasDomFocus(probe, false)).toBe(false);
  });

  it('reports blur on iOS too when focus moved outside the editor', () => {
    const { probe, outside } = fixture(false);
    outside.focus();
    withDocumentFocus(false);
    expect(editorHasDomFocus(probe, true)).toBe(false);
  });
});
