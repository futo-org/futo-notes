import { describe, it, expect } from 'vitest';
import {
  BRIDGE_VERSION,
  type FutoEditorApi,
  type FutoEditorOutboundMessage,
} from './bridge';

describe('futoBridge contract', () => {
  it('pins the contract version', () => {
    // Bumping this is a deliberate, breaking change — update all three hosts.
    expect(BRIDGE_VERSION).toBe(1);
  });

  it('ready message carries the version', () => {
    const msg: FutoEditorOutboundMessage = { type: 'ready', version: BRIDGE_VERSION };
    expect(msg).toEqual({ type: 'ready', version: 1 });
  });

  it('outbound messages are a discriminated union over `type`', () => {
    const msgs: FutoEditorOutboundMessage[] = [
      { type: 'ready', version: BRIDGE_VERSION },
      { type: 'change', content: '# hi' },
      { type: 'focus', focused: true },
    ];
    expect(msgs.map((m) => m.type)).toEqual(['ready', 'change', 'focus']);
  });

  it('FutoEditorApi surface is the four host-callable methods', () => {
    // A structural stand-in proves the shape compiles; the real impl lives in
    // src/editor-embed/main.ts.
    const api: FutoEditorApi = {
      setContent: () => {},
      getContent: () => '',
      focus: () => {},
      setTheme: () => {},
    };
    expect(Object.keys(api).sort()).toEqual(['focus', 'getContent', 'setContent', 'setTheme']);
  });
});
