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
    expect(BRIDGE_VERSION).toBe(8);
  });

  it('ready message carries the version', () => {
    const msg: FutoEditorOutboundMessage = { type: 'ready', version: BRIDGE_VERSION };
    expect(msg).toEqual({ type: 'ready', version: 8 });
  });

  it('initialized message carries the version', () => {
    const msg: FutoEditorOutboundMessage = { type: 'initialized', version: BRIDGE_VERSION };
    expect(msg).toEqual({ type: 'initialized', version: 8 });
  });

  it('outbound messages are a discriminated union over `type`', () => {
    const msgs: FutoEditorOutboundMessage[] = [
      { type: 'ready', version: BRIDGE_VERSION },
      { type: 'initialized', version: BRIDGE_VERSION },
      { type: 'bridgeVersionMismatch', hostVersion: 7, bundleVersion: 8 },
      { type: 'change', content: '# hi' },
      { type: 'focus', focused: true },
      { type: 'openNote', id: 'folder/note' },
      { type: 'openUrl', url: 'https://futo.org' },
      { type: 'findMatches', query: 'cat', current: 3, total: 17, label: '3 of 17' },
      { type: 'pickImage', source: 'camera' },
      { type: 'pickImage', source: 'library' },
      { type: 'cursorContext', onListLine: true },
      { type: 'saveImageData', data: 'aGk=', ext: 'png' },
      { type: 'pasteClipboardImage' },
    ];
    expect(msgs.map((m) => m.type)).toEqual([
      'ready',
      'initialized',
      'bridgeVersionMismatch',
      'change',
      'focus',
      'openNote',
      'openUrl',
      'findMatches',
      'pickImage',
      'pickImage',
      'cursorContext',
      'saveImageData',
      'pasteClipboardImage',
    ]);
  });

  it('FutoEditorApi surface is the seventeen host-callable methods', () => {
    // A structural stand-in proves the shape compiles; the real impl lives in
    // src/editor-embed/main.ts.
    const api: FutoEditorApi = {
      initialize: () => {},
      setContent: () => {},
      getContent: () => '',
      focus: () => {},
      blur: () => {},
      setTheme: () => {},
      setLanguage: () => {},
      setNotes: () => {},
      applyExternalContent: () => {},
      insertImage: () => {},
      setImageBaseUrl: () => {},
      openFind: () => {},
      setFindQuery: () => {},
      stepFind: () => {},
      closeFind: () => {},
      exec: () => {},
      setNativeToolbar: () => {},
    };
    expect(Object.keys(api).sort()).toEqual([
      'applyExternalContent',
      'blur',
      'closeFind',
      'exec',
      'focus',
      'getContent',
      'initialize',
      'insertImage',
      'openFind',
      'setContent',
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

  it('posts v2 messages to the iOS handler as structured objects', () => {
    const postMessage = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage } } };

    postToHost({ type: 'openNote', id: 'a/b' });
    postToHost({ type: 'pickImage', source: 'library' });

    expect(postMessage).toHaveBeenNthCalledWith(1, { type: 'openNote', id: 'a/b' });
    expect(postMessage).toHaveBeenNthCalledWith(2, { type: 'pickImage', source: 'library' });
  });

  it('posts v2 messages to the Android handler as JSON strings', () => {
    const postMessage = vi.fn();
    g.futoBridge = { postMessage };

    postToHost({ type: 'openNote', id: 'a/b' });
    postToHost({ type: 'pickImage', source: 'camera' });

    expect(postMessage).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'openNote', id: 'a/b' }));
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'pickImage', source: 'camera' }),
    );
  });

  it('serializes a saveImageData (clipboard paste) message for both transports', () => {
    const ios = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage: ios } } };
    postToHost({ type: 'saveImageData', data: 'aGk=', ext: 'png' });
    expect(ios).toHaveBeenCalledWith({ type: 'saveImageData', data: 'aGk=', ext: 'png' });
    delete g.webkit;

    const android = vi.fn();
    g.futoBridge = { postMessage: android };
    postToHost({ type: 'saveImageData', data: 'aGk=', ext: 'png' });
    expect(android).toHaveBeenCalledWith(
      JSON.stringify({ type: 'saveImageData', data: 'aGk=', ext: 'png' }),
    );
  });

  it('serializes an openUrl (external-link follow) message for both transports', () => {
    const ios = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage: ios } } };
    postToHost({ type: 'openUrl', url: 'https://futo.org' });
    expect(ios).toHaveBeenCalledWith({ type: 'openUrl', url: 'https://futo.org' });
    delete g.webkit;

    const android = vi.fn();
    g.futoBridge = { postMessage: android };
    postToHost({ type: 'openUrl', url: 'https://futo.org' });
    expect(android).toHaveBeenCalledWith(
      JSON.stringify({ type: 'openUrl', url: 'https://futo.org' }),
    );
  });

  it('serializes pasteClipboardImage even though Android normally ignores the fallback', () => {
    const ios = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage: ios } } };
    postToHost({ type: 'pasteClipboardImage' });
    expect(ios).toHaveBeenCalledWith({ type: 'pasteClipboardImage' });
    delete g.webkit;

    const android = vi.fn();
    g.futoBridge = { postMessage: android };
    postToHost({ type: 'pasteClipboardImage' });
    expect(android).toHaveBeenCalledWith(JSON.stringify({ type: 'pasteClipboardImage' }));
  });

  it('prefers the iOS handler when both transports are present', () => {
    const ios = vi.fn();
    const android = vi.fn();
    g.webkit = { messageHandlers: { futoBridge: { postMessage: ios } } };
    g.futoBridge = { postMessage: android };

    postToHost({ type: 'focus', focused: false });

    expect(ios).toHaveBeenCalledTimes(1);
    expect(android).not.toHaveBeenCalled();
  });

  it('is a no-op in a plain browser with no host', () => {
    expect(() => postToHost({ type: 'change', content: 'x' })).not.toThrow();
  });
});
