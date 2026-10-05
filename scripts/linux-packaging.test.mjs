import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const tauriRoot = new URL('../apps/tauri/src-tauri/', import.meta.url);

describe('Linux desktop packaging identity', () => {
  it('installs an alias matching the native Wayland app ID', async () => {
    const waylandAppId = 'futo-notes-tauri';
    const desktopDestination = '/usr/share/applications/futo-notes-tauri.desktop';
    const desktopSource = 'linux/futo-notes-tauri.desktop';
    const desktopEntry = await readFile(new URL(desktopSource, tauriRoot), 'utf8');
    const config = JSON.parse(await readFile(new URL('tauri.conf.json', tauriRoot), 'utf8'));
    const fields = Object.fromEntries(
      desktopEntry
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split(/=(.*)/s, 2)),
    );

    expect(fields.StartupWMClass).toBe(waylandAppId);
    expect(fields.Icon).toBe(waylandAppId);
    expect(fields.NoDisplay).toBe('true');
    for (const format of ['deb', 'rpm']) {
      expect(config.bundle.linux[format].files[desktopDestination]).toBe(desktopSource);
    }
  });

  it('overlays package versions without changing the tracked Tauri config', () => {
    const justfile = readFileSync(new URL('../justfile', import.meta.url), 'utf8');
    for (const [name, bundle] of [
      ['deploy-deb', 'deb'],
      ['deploy-rpm', 'rpm'],
    ]) {
      const start = justfile.indexOf(`${name}:`);
      const tail = justfile.slice(start + name.length);
      const nextRecipe = tail.search(/^[a-z][\w-]*(?: [^\n]*)?:/m);
      const end = nextRecipe < 0 ? -1 : start + name.length + nextRecipe;
      const recipe = justfile.slice(start, end < 0 ? undefined : end);

      expect(recipe).toContain('VERSION_CONFIG_DIR=$(mktemp -d)');
      expect(recipe).toContain('printf \'{"version":"%s"}\\n\' "$VERSION" > "$VERSION_CONFIG"');
      expect(recipe).toContain(`cargo tauri build --bundles ${bundle} --config "$VERSION_CONFIG"`);
      expect(recipe).not.toContain('git checkout');
      expect(recipe).not.toContain('tauri.conf.json');
    }
  });
});
