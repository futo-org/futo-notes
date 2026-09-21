import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { updateGeneratedFiles } from './generated-files.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-generated-files-'));

afterAll(() => fs.rmSync(scratch, { recursive: true }));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('updateGeneratedFiles', () => {
  it('checks without writing and writes stale or missing targets byte-for-byte', () => {
    const existing = 'generated/existing.txt';
    const missing = 'generated/missing.txt';
    fs.mkdirSync(path.join(scratch, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(scratch, existing), 'old');
    const targets = [
      { rel: existing, render: () => 'new' },
      { rel: missing, render: () => 'created' },
    ];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    updateGeneratedFiles(scratch, targets, 'source.ts', 'generate', true);

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(scratch, existing), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(scratch, missing))).toBe(false);

    process.exitCode = undefined;
    updateGeneratedFiles(scratch, targets, 'source.ts', 'generate', false);
    expect(fs.readFileSync(path.join(scratch, existing), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(scratch, missing), 'utf8')).toBe('created');

    updateGeneratedFiles(scratch, targets, 'source.ts', 'generate', true);
    expect(process.exitCode).toBeUndefined();
  });
});
