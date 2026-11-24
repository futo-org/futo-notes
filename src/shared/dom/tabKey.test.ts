// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { isTabKey } from './tabKey';

const key = (init: KeyboardEventInit) => isTabKey(new KeyboardEvent('keydown', init));

describe('isTabKey', () => {
  it('is Tab by name, or by code when WebKitGTK names Shift+Tab Unidentified', () => {
    expect(key({ key: 'Tab' })).toBe(true);
    expect(key({ key: 'Unidentified', code: 'Tab', shiftKey: true })).toBe(true);
    expect(key({ key: 'a', code: 'KeyA' })).toBe(false);
  });

  it('leaves an input method its own Tab', () => {
    expect(key({ key: 'Process', code: 'Tab', isComposing: true })).toBe(false);
  });
});
