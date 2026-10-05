import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

describe('Tauri capabilities', () => {
  const capsPath = path.resolve(__dirname, '../../apps/tauri/src-tauri/capabilities/default.json');
  const caps = JSON.parse(readFileSync(capsPath, 'utf-8'));

  it.each([
    ['core:window:allow-destroy', 'so the close handler can force-close the window'],
    ['core:window:allow-set-title', 'so the localized application title reaches the native window'],
    ['process:allow-exit', 'so the app can exit cleanly'],
  ])('includes %s %s', (permission) => {
    expect(caps.permissions).toContain(permission);
  });

  // The license deep link is delivered by the plugin, and the plugin only
  // recognises a scheme the CONFIG declares — `handle_cli_arguments` drops any
  // argument whose scheme is not listed, and the macOS bundle's
  // CFBundleURLTypes is generated from it. Lose this block and
  // `futonotes://license/…` silently stops arriving, with nothing to fail.
  it('registers the futonotes scheme for the deep-link plugin', () => {
    const confPath = path.resolve(__dirname, '../../apps/tauri/src-tauri/tauri.conf.json');
    const conf = JSON.parse(readFileSync(confPath, 'utf-8'));

    expect(conf.plugins['deep-link'].desktop.schemes).toContain('futonotes');
    expect(caps.permissions).toContain('deep-link:default');
  });
});
