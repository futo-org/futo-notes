// The website publisher against a fake GitLab API: what it commits, and the
// cases where it must do nothing. No network.

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { publishWebsitePost, readRepoFile } from './publish-website-post.mjs';

const SCRIPT = fileURLToPath(new URL('./publish-website-post.mjs', import.meta.url));

// Runs the real CLI entry point from a directory that is not the repo root, with
// no token and no network: only paths that return before any fetch are safe.
function runCli(args, env = {}) {
  const { WEBSITE_REPO_TOKEN: _token, CI_COMMIT_TAG: _tag, ...base } = process.env;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmpdir(),
    env: { ...base, ...env },
    encoding: 'utf8',
  });
}

const NOTES =
  '# v1.9.0\n\nFind in note.\n\n- Faster search.\n\n## Short\n\nFind in note and faster search.\n';
const LLMS =
  'intro\n\n- [Changelog](https://notes.futo.tech/blog.md): all\n\n- [FUTO Notes 1.8.0](https://notes.futo.tech/blog/futo-notes-1-8-0.md): old\n';

function setup({
  files = { 'public/llms.txt': LLMS },
  env = { WEBSITE_REPO_TOKEN: 't' },
  tag = 'v1.9.0',
} = {}) {
  const posts = [];
  const logs = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      posts.push({ path: u.pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'abcdef0123', web_url: 'https://mr' }), {
        status: 201,
      });
    }
    const file = decodeURIComponent(u.pathname.split('/files/')[1].replace('/raw', ''));
    return file in files ? new Response(files[file]) : new Response('nf', { status: 404 });
  };
  const run = () =>
    publishWebsitePost({
      tag,
      env,
      fetchImpl,
      readNotes: () => NOTES,
      today: '2026-10-20',
      log: (m) => logs.push(m),
    });
  return { run, posts, logs };
}

describe('publishWebsitePost', () => {
  it('commits the post and the llms.txt line to main', async () => {
    const { run, posts } = setup();
    expect(await run()).toBe('committed');
    const { body } = posts[0];
    expect(body.branch).toBe('main');
    const [post, llms] = body.actions;
    expect(post.file_path).toBe('src/content/blog/futo-notes-1-9-0.md');
    expect(post.content).toContain(
      'title: "FUTO Notes 1.9.0"\nversions: ["v1.9.0"]\ndate: 2026-10-20\nsummary: "Find in note and faster search"',
    );
    expect(post.content).toContain('- Faster search.');
    expect(post.content).not.toContain('## Short');
    const lines = llms.content.split('\n');
    const added = lines.findIndex((l) => l.includes('futo-notes-1-9-0.md'));
    expect(lines[added + 1]).toContain('futo-notes-1-8-0.md');
  });

  it('does nothing when the website already has a post for the version', async () => {
    const { run, posts, logs } = setup({
      files: { 'public/llms.txt': LLMS, 'src/content/blog/futo-notes-1-9-0.md': 'by hand' },
    });
    expect(await run()).toBe('exists');
    expect(posts).toEqual([]);
    expect(logs[0]).toMatch(/already has/);
  });

  it('fails without a token on a stable tag, so the job is not silently green', async () => {
    const { run, posts } = setup({ env: {} });
    await expect(run()).rejects.toThrow(/WEBSITE_REPO_TOKEN/);
    expect(posts).toEqual([]);
  });

  it('skips a non-stable tag even without a token', async () => {
    const rc = setup({ tag: 'v1.9.0-2', env: {} });
    expect(await rc.run()).toBe('skipped');
    expect(rc.posts).toEqual([]);
  });

  it('CLI exits non-zero for a stable tag with no token', () => {
    const res = runCli(['--tag', 'v1.9.0']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/WEBSITE_REPO_TOKEN/);
  });

  it('CLI exits 0 with a skip message for a prerelease tag', () => {
    const res = runCli(['--tag', 'v1.9.0-2']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not a stable/);
  });

  it('reads release notes relative to the repo root, not the cwd', () => {
    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { readRepoFile } = await import(${JSON.stringify(new URL('./publish-website-post.mjs', import.meta.url).href)});
         process.stdout.write(readRepoFile('release-notes/README.md').slice(0, 12));`,
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(readRepoFile('release-notes/README.md').slice(0, 12));
    expect(res.stdout.length).toBe(12);
  });

  it('opens a branch and MR instead when WEBSITE_RELEASE_MODE=mr', async () => {
    const { run, posts } = setup({ env: { WEBSITE_REPO_TOKEN: 't', WEBSITE_RELEASE_MODE: 'mr' } });
    expect(await run()).toBe('mr');
    expect(posts[0].body.branch).toBe('release-post-v1.9.0');
    expect(posts[1].path).toMatch(/merge_requests$/);
  });
});
