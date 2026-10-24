import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJustfileSource } from './lib/justfile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readJustfileSource(root);
const recipe = /^test-android-native(?=\s|:)[^\n]*\n((?:[ \t][^\n]*\n|\n)*)/m.exec(source);
if (!recipe) throw new Error('missing Android JVM recipe');
const body = recipe[1]
  .split('\n')
  .map((line) => line.replace(/^  /, ''))
  .join('\n');

describe('Android JVM recipe selection', () => {
  let scratch;
  let record;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-unit-recipe-'));
    record = path.join(scratch, 'args.json');
    const gradle = path.join(scratch, 'apps/android/gradlew');
    const vite = path.join(scratch, 'node_modules/.bin/vite');
    for (const file of [gradle, vite]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      gradle,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.QA_RECIPE_RECORD, JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(vite, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync('bash', ['-euc', body, 'recipe', ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, QA_RECIPE_RECORD: record },
    });

  it('runs all tests under both flavors by default', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:testDirectDebugUnitTest',
      ':app:testPlayDebugUnitTest',
    ]);
  });

  it('applies class and method patterns to each flavor without shell splitting', () => {
    const patterns = [
      'com.futo.notes.LocalizationTest',
      'com.futo.notes.OtherTest.method with spaces',
    ];
    const result = run(...patterns);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:testDirectDebugUnitTest',
      '--tests',
      patterns[0],
      '--tests',
      patterns[1],
      ':app:testPlayDebugUnitTest',
      '--tests',
      patterns[0],
      '--tests',
      patterns[1],
    ]);
  });

  it('keeps SDK preflight and regenerated bindings before Gradle', () => {
    expect(recipe[0].split('\n')[0]).toMatch(/android-env-check.*\(build-rust-android "device"\)/);
  });
});
