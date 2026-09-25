import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkSkill, skillSourceFor } from './skills-link.mjs';

const scratch = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-link-'));
  scratch.push(dir);
  return dir;
}
afterEach(() =>
  scratch.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

describe('skills-link worktree fallback', () => {
  it('uses a sibling checkout only when its skill lock matches', () => {
    const root = tempDir();
    const sibling = tempDir();
    const lockText = '{"skills":{"code-review":{"computedHash":"abc"}}}';
    fs.writeFileSync(path.join(sibling, 'skills-lock.json'), lockText);
    const skill = path.join(sibling, '.agents', 'skills', 'code-review');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'pinned review instructions');

    expect(skillSourceFor('code-review', { root, lockText, worktreeRoots: [sibling] })).toBe(skill);

    fs.writeFileSync(path.join(sibling, 'skills-lock.json'), '{"skills":{}}');
    expect(skillSourceFor('code-review', { root, lockText, worktreeRoots: [sibling] })).toBeNull();
  });

  it('copies a pinned sibling skill locally before linking so worktree cleanup is safe', () => {
    const root = tempDir();
    const sibling = tempDir();
    const lockText = '{"skills":{"code-review":{"computedHash":"abc"}}}';
    fs.writeFileSync(path.join(sibling, 'skills-lock.json'), lockText);
    const siblingSkill = path.join(sibling, '.agents', 'skills', 'code-review');
    fs.mkdirSync(siblingSkill, { recursive: true });
    fs.writeFileSync(path.join(siblingSkill, 'SKILL.md'), 'pinned review instructions');

    expect(linkSkill('code-review', { root, lockText, worktreeRoots: [sibling] })).toBe('linked');
    fs.rmSync(sibling, { recursive: true, force: true });

    const target = path.join(root, '.claude', 'skills', 'code-review');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(
      'pinned review instructions',
    );
    expect(fs.realpathSync(target)).toBe(
      fs.realpathSync(path.join(root, '.agents', 'skills', 'code-review')),
    );
  });

  it('replaces a dangling link without asking realpath to resolve its missing target', () => {
    const root = tempDir();
    const local = path.join(root, '.agents', 'skills', 'code-review');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'SKILL.md'), 'local skill');
    const target = path.join(root, '.claude', 'skills', 'code-review');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync('../../missing/.agents/skills/code-review', target);

    expect(linkSkill('code-review', { root, lockText: '{}' })).toBe('linked');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('local skill');
  });

  it('prefers a locally installed skill over any sibling copy', () => {
    const root = tempDir();
    const sibling = tempDir();
    const lockText = '{"skills":{}}';
    fs.writeFileSync(path.join(sibling, 'skills-lock.json'), lockText);
    const local = path.join(root, '.agents', 'skills', 'code-review');
    fs.mkdirSync(local, { recursive: true });

    expect(skillSourceFor('code-review', { root, lockText, worktreeRoots: [sibling] })).toBe(local);
  });
});
