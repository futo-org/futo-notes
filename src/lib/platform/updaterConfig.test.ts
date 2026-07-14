import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');
const readConf = (name: string) => JSON.parse(readFileSync(resolve(SRC_TAURI, name), 'utf8'));

describe('base tauri.conf.json updater config', () => {
  const base = readConf('tauri.conf.json');
  const updater = base.plugins?.updater;

  it('declares an updater block with a non-empty pubkey', () => {
    expect(updater).toBeDefined();
    expect(typeof updater.pubkey).toBe('string');
    expect(updater.pubkey.length).toBeGreaterThan(0);
  });

  it('uses only https endpoints (never http/localhost) in production', () => {
    expect(Array.isArray(updater.endpoints)).toBe(true);
    expect(updater.endpoints.length).toBeGreaterThan(0);
    for (const ep of updater.endpoints) {
      expect(ep, `endpoint must be https: ${ep}`).toMatch(/^https:\/\//);
      expect(ep).not.toContain('localhost');
      expect(ep).not.toContain('127.0.0.1');
    }
  });

  it('never enables dangerousInsecureTransportProtocol in production', () => {
    expect(updater.dangerousInsecureTransportProtocol).toBeFalsy();
  });

  it('keeps createUpdaterArtifacts OFF in base so keyless builds still work', () => {
    expect(base.bundle?.createUpdaterArtifacts).toBeFalsy();
  });
});

describe('dev config overlay', () => {
  const dev = readConf('tauri.dev.conf.json');

  it('does NOT override the updater block (inherits the secure base endpoint)', () => {
    expect(dev.plugins?.updater).toBeUndefined();
  });
});

describe('release overlay (tauri.updater-release.conf.json)', () => {
  const overlay = readConf('tauri.updater-release.conf.json');

  it('enables createUpdaterArtifacts (CI release build signs + emits .sig)', () => {
    expect(overlay.bundle.createUpdaterArtifacts).toBe(true);
  });

  it('does NOT override the updater block — endpoint + pubkey come from base', () => {
    expect(overlay.plugins?.updater).toBeUndefined();
  });

  it('does NOT override identifier/productName — prod ships under the base bundle id', () => {
    expect(overlay.identifier).toBeUndefined();
    expect(overlay.productName).toBeUndefined();
  });
});

describe('localdev overlay (tauri.updater-localdev.conf.json) — the trust boundary', () => {
  const base = readConf('tauri.conf.json');
  const release = readConf('tauri.updater-release.conf.json');
  const localdev = readConf('tauri.updater-localdev.conf.json');
  const lu = localdev.plugins.updater;

  it('enables createUpdaterArtifacts (the local verified build signs too)', () => {
    expect(localdev.bundle.createUpdaterArtifacts).toBe(true);
  });

  it('is the ONLY place localhost + insecure transport are allowed', () => {
    expect(lu.dangerousInsecureTransportProtocol).toBe(true);
    expect(
      lu.endpoints.every((e: string) => e.includes('localhost') || e.includes('127.0.0.1')),
    ).toBe(true);
  });

  it('uses a localdev pubkey that is NOT the production pubkey', () => {
    expect(typeof lu.pubkey).toBe('string');
    expect(lu.pubkey.length).toBeGreaterThan(0);
    expect(lu.pubkey).not.toBe(base.plugins.updater.pubkey);
  });

  it('localdev pubkey matches the committed signing key (keys/localdev-updater.key.pub)', () => {
    const committedPub = readFileSync(
      resolve(ROOT, 'keys/localdev-updater.key.pub'),
      'utf8',
    ).trim();
    expect(lu.pubkey).toBe(committedPub);
  });

  it('runs under the dev identifier, never prod', () => {
    const dev = readConf('tauri.dev.conf.json');
    expect(localdev.identifier).toBe('com.futo.notes.dev');
    expect(localdev.identifier).toBe(dev.identifier);
    expect(localdev.identifier).not.toBe(base.identifier);
  });

  it('its localhost/insecure/localdev-key NEVER leak into base (prod) or the release overlay', () => {
    expect(base.plugins.updater.dangerousInsecureTransportProtocol).toBeFalsy();
    expect(base.plugins.updater.endpoints.every((e: string) => e.startsWith('https://'))).toBe(
      true,
    );
    expect(base.plugins.updater.pubkey).not.toBe(lu.pubkey);
    expect(release.plugins?.updater).toBeUndefined();
  });
});
