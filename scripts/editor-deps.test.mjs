import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWorkspaceDependencies, missingWorkspaceDependencies } from './editor-deps.mjs';

const fixtures = [];

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-deps-'));
  fixtures.push(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { ws: '^8.21.3' } }),
  );
  return root;
}

function installVite(root) {
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'vite'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function installAjv(root) {
  const dir = path.join(root, 'node_modules', 'ajv');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'dist', '2020.js'), 'export default class Ajv2020 {}');
}

function installWs(root, version = '8.21.3') {
  const dir = path.join(root, 'node_modules', 'ws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version, main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class WebSocket {}');
}

function installAll(root) {
  installVite(root);
  installAjv(root);
  installWs(root);
}

afterEach(() =>
  fixtures.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

describe('workspace dependency preflight', () => {
  it('installs a fresh worktree before a build dependency is missing', () => {
    const root = createFixture();
    let installs = 0;

    const result = ensureWorkspaceDependencies(root, (workspace) => {
      installs += 1;
      installAll(workspace);
    });

    expect(result.installed).toBe(true);
    expect(installs).toBe(1);
    expect(missingWorkspaceDependencies(root)).toEqual([]);
  });

  it('repairs stale node_modules missing AJV even when Vite exists', () => {
    const root = createFixture();
    installVite(root);
    installWs(root);
    let installs = 0;

    const result = ensureWorkspaceDependencies(root, (workspace) => {
      installs += 1;
      installAll(workspace);
    });

    expect(result.installed).toBe(true);
    expect(installs).toBe(1);
    expect(missingWorkspaceDependencies(root)).toEqual([]);
  });

  it('repairs an incompatible local ws version instead of using it', () => {
    const root = createFixture();
    installVite(root);
    installAjv(root);
    installWs(root, '7.5.9');
    let installs = 0;

    const result = ensureWorkspaceDependencies(root, (workspace) => {
      installs += 1;
      installAll(workspace);
    });

    expect(result.installed).toBe(true);
    expect(installs).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'ws', 'package.json'))).version,
    ).toBe('8.21.3');
  });

  it('fails with a repair instruction when pnpm install leaves dependencies stale', () => {
    const root = createFixture();
    installVite(root);

    expect(() => ensureWorkspaceDependencies(root, () => {})).toThrow(
      /still missing or incompatible after pnpm install.*Remove node_modules and run pnpm install/,
    );
  });

  it('places the same preflight before direct language and full-unit scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    expect(packageJson.scripts['check:languages']).toMatch(/^node scripts\/editor-deps\.mjs &&/);
    expect(packageJson.scripts['test:unit:full']).toMatch(/^node scripts\/editor-deps\.mjs &&/);
  });
});
