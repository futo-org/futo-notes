import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJustfileSource } from './lib/justfile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readJustfileSource(root);
function recipe(name) {
  const match = new RegExp(`^${name}(?=\\s|:)[^\\n]*\\n((?:[ \\t][^\\n]*\\n|\\n)*)`, 'm').exec(
    source,
  );
  if (!match) throw new Error(`missing ${name} recipe`);
  return { header: match[0].split('\n')[0], body: match[1].replace(/^  /gm, '') };
}
const unit = recipe('test-android-native');
const ui = recipe('test-android-native-ui');

describe('Android native recipe selection', () => {
  let scratch;
  let record;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-unit-recipe-'));
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
  const run = ({ body }, ...args) =>
    spawnSync('bash', ['-euc', body, 'recipe', ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, QA_RECIPE_RECORD: record },
    });

  it('runs all tests under both flavors by default', () => {
    const result = run(unit);
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
    const result = run(unit, ...patterns);
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
    expect(unit.header).toMatch(/android-env-check.*\(build-rust-android "device"\)/);
  });

  it('runs the full suite when no class is supplied', () => {
    const result = run(ui);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:connectedDirectDebugAndroidTest',
    ]);
  });

  it('forwards only the named classes or methods to the Android runner', () => {
    const result = run(ui, 'com.futo.notes.DialogImeDismissTest', 'com.futo.notes.OtherTest#works');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([
      ':app:connectedDirectDebugAndroidTest',
      '-Pandroid.testInstrumentationRunnerArguments.class=com.futo.notes.DialogImeDismissTest,com.futo.notes.OtherTest#works',
    ]);
  });

  it('rejects invalid selectors before Gradle can silently run everything', () => {
    const result = run(ui, '--help');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected a fully qualified Android test class');
    expect(fs.existsSync(record)).toBe(false);
  });
});
