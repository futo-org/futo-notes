import { describe, expect, it } from 'vitest';

import { imeOccupiesScreen } from './android-device.mjs';

describe('imeOccupiesScreen', () => {
  it('rejects Android 16 input state whose visible IME frame has zero height', () => {
    expect(
      imeOccupiesScreen(
        'InsetsSource id=3 type=ime frame=[0,1600][720,1600] visibleFrame=[0,1600][720,1600] visible=true flags=',
      ),
    ).toBe(false);
  });

  it('accepts a visible IME inset that actually covers screen pixels', () => {
    expect(
      imeOccupiesScreen(
        'InsetsSource id=3 type=ime frame=[0,960][720,1600] visibleFrame=[0,960][720,1600] visible=true flags=',
      ),
    ).toBe(true);
  });

  it('rejects a nonzero IME frame when the inset is hidden', () => {
    expect(
      imeOccupiesScreen(
        'InsetsSource id=3 type=ime frame=[0,960][720,1600] visibleFrame=[0,960][720,1600] visible=false flags=',
      ),
    ).toBe(false);
  });
});
