import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Regression test: the app couldn't close on Linux because the close handler
 * calls e.preventDefault() then Window.destroy(), but the `core:window:allow-destroy`
 * permission was missing from capabilities — so destroy() silently failed and the
 * window stayed open.
 */
describe('Tauri capabilities', () => {
  const capsPath = path.resolve(__dirname, '../../apps/tauri/src-tauri/capabilities/default.json');
  const caps = JSON.parse(readFileSync(capsPath, 'utf-8'));

  it('includes core:window:allow-destroy so the close handler can force-close the window', () => {
    expect(caps.permissions).toContain('core:window:allow-destroy');
  });

  it('includes process:allow-exit so the app can exit cleanly', () => {
    expect(caps.permissions).toContain('process:allow-exit');
  });
});
