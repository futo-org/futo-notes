// The website publisher against a fake GitLab API: what it commits, and the
// cases where it must do nothing. No network.

import { describe, expect, it } from 'vitest';

import { publishWebsitePost } from './publish-website-post.mjs';

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

  it('skips without a token and for non-stable tags', async () => {
    const noToken = setup({ env: {} });
    expect(await noToken.run()).toBe('skipped');
    expect(noToken.logs[0]).toMatch(/WEBSITE_REPO_TOKEN/);
    const rc = setup({ tag: 'v1.9.0-2' });
    expect(await rc.run()).toBe('skipped');
    expect(rc.posts).toEqual([]);
  });

  it('opens a branch and MR instead when WEBSITE_RELEASE_MODE=mr', async () => {
    const { run, posts } = setup({ env: { WEBSITE_REPO_TOKEN: 't', WEBSITE_RELEASE_MODE: 'mr' } });
    expect(await run()).toBe('mr');
    expect(posts[0].body.branch).toBe('release-post-v1.9.0');
    expect(posts[1].path).toMatch(/merge_requests$/);
  });
});
