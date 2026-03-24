import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateAdminToken,
  getAdminToken,
  writeAdminToken,
} from '../../src/auth/adminToken.js';

describe('adminToken', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeAdminToken writes the token file with correct content', () => {
    const token = 'test-token-value';
    writeAdminToken(tmpDir, token);

    const tokenPath = path.join(tmpDir, '.admin-token');
    const content = readFileSync(tokenPath, 'utf-8');
    expect(content).toBe(token + '\n');
  });

  it('writeAdminToken sets file permissions to 0o600', () => {
    writeAdminToken(tmpDir, 'secret');

    const tokenPath = path.join(tmpDir, '.admin-token');
    const stat = statSync(tokenPath);
    // mode & 0o777 gives the permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('generateAdminToken returns a 64-char hex string', () => {
    const token = generateAdminToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getAdminToken returns the last generated token', () => {
    const token = generateAdminToken();
    expect(getAdminToken()).toBe(token);
  });
});
