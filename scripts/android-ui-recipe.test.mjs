import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJustfileSource } from './lib/justfile.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Execute the recipe body against stub Vite/Gradle: no SDK or device is touched.
const source = readJustfileSource(root);
const recipe = /^test-android-native-ui[^\n]*:\s*[^\n]*\n((?:[ \t][^\n]*\n|\n)*)/m.exec(source);
if (!recipe) throw new Error('missing Android UI recipe');
const body = recipe[1]
  .split('\n')
  .map((line) => line.replace(/^  /, ''))
  .join('\n');

describe('Android instrumentation recipe selection', () => {
  let scratch;
  let record;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-ui-recipe-'));
    record = path.join(scratch, 'args.json');
    const gradle = path.join(scratch, 'apps/android/gradlew');
    const vite = path.join(scratch, 'node_modules/.bin/vite');
    const qa = path.join(scratch, 'scripts/qa.mjs');
    for (const file of [gradle, vite, qa]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      gradle,
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.QA_RECIPE_RECORD, JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(vite, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(qa, '');
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync('bash', ['-euc', body, 'recipe', ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, QA_RECIPE_RECORD: record },
    });

  it('runs the full suite when no class is supplied', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:connectedDirectDebugAndroidTest',
    ]);
  });

  it('forwards only the named classes or methods to the Android runner', () => {
    const result = run('com.futo.notes.DialogImeDismissTest', 'com.futo.notes.OtherTest#works');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:connectedDirectDebugAndroidTest',
      '-Pandroid.testInstrumentationRunnerArguments.class=com.futo.notes.DialogImeDismissTest,com.futo.notes.OtherTest#works',
    ]);
  });

  it('rejects invalid selectors before Gradle can silently run everything', () => {
    const result = run('--help');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected a fully qualified Android test class');
    expect(fs.existsSync(record)).toBe(false);
  });
});
