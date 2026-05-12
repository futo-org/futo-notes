// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imeShieldPlugin } from './imeShield';

interface FakeBridge {
  update: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  debugSummary: () => string;
}

function installFakeBridge(): FakeBridge {
  const bridge: FakeBridge = {
    update: vi.fn(),
    setActive: vi.fn(),
    reset: vi.fn(),
    debugSummary: () => 'fake',
  };
  (window as unknown as { __FutoImeShield__?: FakeBridge }).__FutoImeShield__ = bridge;
  return bridge;
}

function uninstallBridge() {
  delete (window as unknown as { __FutoImeShield__?: FakeBridge }).__FutoImeShield__;
}

function lastCall<T extends unknown[]>(calls: T[]): T | undefined {
  return calls.length > 0 ? calls[calls.length - 1] : undefined;
}

function makeEditor(doc = ''): { view: EditorView; bridge: FakeBridge } {
  const bridge = installFakeBridge();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({ doc, extensions: [imeShieldPlugin] });
  const view = new EditorView({ state, parent });
  return { view, bridge };
}

describe('imeShieldPlugin', () => {
  beforeEach(() => uninstallBridge());
  afterEach(() => uninstallBridge());

  it('pushes initial state on mount', () => {
    const { view, bridge } = makeEditor('hello');
    expect(bridge.update).toHaveBeenCalled();
    const args = bridge.update.mock.calls[0];
    expect(args[0]).toBe('hello');
    expect(args[1]).toBe(0);
    expect(args[2]).toBe(0);
    expect(typeof args[3]).toBe('number');
    view.destroy();
  });

  it('pushes a fresh update on doc change with monotonically increasing serial', () => {
    const { view, bridge } = makeEditor('a');
    const initialCalls = bridge.update.mock.calls.length;
    view.dispatch({ changes: { from: 1, insert: 'b' } });
    expect(bridge.update.mock.calls.length).toBeGreaterThan(initialCalls);
    const last = lastCall(bridge.update.mock.calls);
    expect(last?.[0]).toBe('ab');
    // Selection should be a valid range within the new doc length.
    expect(last?.[1]).toBeGreaterThanOrEqual(0);
    expect(last?.[1]).toBeLessThanOrEqual(2);
    expect(last?.[2]).toBeGreaterThanOrEqual(last?.[1] ?? 0);
    expect(last?.[2]).toBeLessThanOrEqual(2);
    // Serial monotonic.
    const serials = bridge.update.mock.calls.map((c) => c[3] as number);
    for (let i = 1; i < serials.length; i++) {
      expect(serials[i]).toBeGreaterThan(serials[i - 1]);
    }
    view.destroy();
  });

  it('does not call bridge.update when nothing relevant changed', () => {
    const { view, bridge } = makeEditor('hello');
    const before = bridge.update.mock.calls.length;
    // Dispatching with no changes and no selection move shouldn't push.
    view.dispatch({});
    const after = bridge.update.mock.calls.length;
    expect(after).toBe(before);
    view.destroy();
  });

  it('pushes on selection change even without doc change', () => {
    const { view, bridge } = makeEditor('hello');
    const before = bridge.update.mock.calls.length;
    view.dispatch({ selection: { anchor: 3, head: 5 } });
    expect(bridge.update.mock.calls.length).toBeGreaterThan(before);
    const last = lastCall(bridge.update.mock.calls);
    expect(last?.[1]).toBe(3);
    expect(last?.[2]).toBe(5);
    view.destroy();
  });

  it('calls bridge.reset on destroy', () => {
    const { view, bridge } = makeEditor('hi');
    view.destroy();
    expect(bridge.reset).toHaveBeenCalled();
  });

  it('marks the shield active only while the editor body is focused', () => {
    const { view, bridge } = makeEditor('');

    view.contentDOM.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(bridge.setActive).toHaveBeenLastCalledWith(true);

    view.contentDOM.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(bridge.setActive).toHaveBeenLastCalledWith(false);

    view.destroy();
  });

  it('is a no-op when bridge is not installed', () => {
    // No installFakeBridge — bridge undefined.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const state = EditorState.create({ doc: 'hi', extensions: [imeShieldPlugin] });
    expect(() => {
      const v = new EditorView({ state, parent });
      v.dispatch({ changes: { from: 2, insert: '!' } });
      v.destroy();
    }).not.toThrow();
  });

  it('swallows bridge throws without crashing the editor', () => {
    const bridge = installFakeBridge();
    bridge.update.mockImplementation(() => {
      throw new Error('JNI bridge mid-teardown');
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const state = EditorState.create({ doc: '', extensions: [imeShieldPlugin] });
    expect(() => {
      const v = new EditorView({ state, parent });
      v.dispatch({ changes: { from: 0, insert: 'x' } });
      v.destroy();
    }).not.toThrow();
  });

  it('handles empty doc correctly (the actual crash scenario)', () => {
    const { view, bridge } = makeEditor('');
    const initial = lastCall(bridge.update.mock.calls);
    expect(initial?.[0]).toBe('');
    expect(initial?.[1]).toBe(0);
    expect(initial?.[2]).toBe(0);
    // Simulate the "user typed a char then deleted it back to empty"
    // sequence. We should still be in the empty state, shadow updated.
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    view.dispatch({ changes: { from: 0, to: 1, insert: '' } });
    const last = lastCall(bridge.update.mock.calls);
    expect(last?.[0]).toBe('');
    expect(last?.[1]).toBe(0);
    expect(last?.[2]).toBe(0);
    view.destroy();
  });
});
