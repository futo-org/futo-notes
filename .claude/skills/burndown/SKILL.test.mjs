import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skill = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');

test('excludes registry entries whose metadata marks them non-actionable', () => {
  assert.match(
    skill,
    /read its `description` and `note` metadata[\s\S]*deliberately accepted[\s\S]*not actionable debt/,
  );
});

test('rejects notes-root-triplet for automatic and override selection', () => {
  assert.match(skill, /Reject `--target notes-root-triplet` with a read-only report/);
  assert.match(skill, /never select it automatically or by `--target`/);
});

test('forbids locking the notes-root guard copies', () => {
  assert.match(skill, /never consolidate, lock, or weaken its[\s\S]*copies/);
  assert.doesNotMatch(skill, /locking it via a shared fixture \+ tests is allowed/);
});
