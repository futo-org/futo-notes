import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BRIDGE_VERSION,
  postToHost,
  type FutoEditorApi,
  type FutoEditorOutboundMessage,
} from './bridge';

describe('futoBridge contract', () => {
  it('pins the contract version', () => {
    // Bumping this is a deliberate, breaking change — update all three hosts.
    expect(BRIDGE_VERSION).toBe(9);
  });

  it('ready message carries the version', () => {
    const msg: FutoEditorOutboundMessage = { type: 'ready', version: BRIDGE_VERSION };
    expect(msg).toEqual({ type: 'ready', version: 9 });
  });

  it('initialized message carries the version', () => {
    const msg: FutoEditorOutboundMessage = { type: 'initialized', version: BRIDGE_VERSION };
    expect(msg).toEqual({ type: 'initialized', version: 9 });
  });

  it('FutoEditorApi surface is the eighteen host-callable methods', () => {
    // A structural stand-in proves the shape compiles; the real impl lives in
    // src/editor-embed/main.ts.
    const api: FutoEditorApi = {
      initialize: () => {},
      setContent: () => {},
      flush: () => {},
      focus: () => {},
      blur: () => {},
      setTheme: () => {},
      setLanguage: () => {},
      setNotes: () => {},
      applyExternalContent: () => {},
      insertImage: () => {},
      setImageBaseUrl: () => {},
      exec: () => {},
      setNativeToolbar: () => {},
      openFind: () => {},
      setFindOverlayInset: () => {},
      setFindQuery: () => {},
      stepFind: () => {},
      closeFind: () => {},
    };
    expect(Object.keys(api).sort()).toEqual([
      'applyExternalContent',
      'blur',
      'closeFind',
      'exec',
      'flush',
      'focus',
      'initialize',
      'insertImage',
      'openFind',
      'setContent',
      'setFindOverlayInset',
      'setFindQuery',
      'setImageBaseUrl',
      'setLanguage',
      'setNativeToolbar',
      'setNotes',
      'setTheme',
      'stepFind',
    ]);
  });
});

describe('postToHost routing', () => {
  const g = globalThis as unknown as {
    webkit?: { messageHandlers?: { futoBridge?: { postMessage(m: unknown): void } } };
    futoBridge?: { postMessage(json: string): void };
  };

  afterEach(() => {
    delete g.webkit;
    delete g.futoBridge;
  });

  it.each<FutoEditorOutboundMessage>([
    { type: 'openNote', id: 'a/b' },
    { type: 'pickImage', source: 'library' },
    { type: 'pickImage', source: 'camera' },
    { type: 'saveImageData', data: 'aGk=', ext: 'png' },
    { type: 'openUrl', url: 'https://futo.org' },
    { type: 'pasteClipboardImage' },
  ])('posts $type to iOS as an object and to Android as a JSON string', (message) => {
    const ios = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage: ios } } };
    postToHost(message);
    expect(ios).toHaveBeenCalledWith(message);
    delete g.webkit;

    const android = vi.fn();
    g.futoBridge = { postMessage: android };
    postToHost(message);
    expect(android).toHaveBeenCalledWith(JSON.stringify(message));
  });

  it('is a no-op in a plain browser with no host', () => {
    expect(() =>
      postToHost({ type: 'change', noteId: 'a', generation: 1, content: 'x' }),
    ).not.toThrow();
  });
});
