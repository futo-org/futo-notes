#!/usr/bin/env node
// Publish a stable release's notes to the website changelog (notes.futo.tech).
//
//   node scripts/publish-website-post.mjs --tag v1.9.0
//
// Reads release-notes/<tag>.md (the store notes), writes
// src/content/blog/futo-notes-X-Y-Z.md plus the matching public/llms.txt line
// in futo-notes/website, via the GitLab commits API. Runs after the GitLab
// release exists (CI job `publish:website-post`, allow_failure).
//
// Never overwrites: a post already on the website (hand-written wins) means
// nothing is done. A stable tag with no WEBSITE_REPO_TOKEN fails (a green job
// that published nothing would hide the miss); `allow_failure` keeps that
// failure from blocking the store publishes. A prerelease tag is a quiet skip.
//
// Env: WEBSITE_REPO_TOKEN (project access token, api scope on the website repo),
//      WEBSITE_RELEASE_MODE = commit (default, straight to main) | mr,
//      WEBSITE_PROJECT (default futo-notes/website), CI_API_V4_URL.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STABLE_TAG_PATTERN, parseReleaseNotes, releaseNotesPath } from './lib/release-notes.mjs';

const SITE = 'https://notes.futo.tech';
const SUMMARY_LIMIT = 200;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Repo-relative paths (release-notes/<tag>.md) resolve from the repo root, so
// the script works from any cwd.
export function readRepoFile(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

export function postSlug(tag) {
  return `futo-notes-${tag.slice(1).replaceAll('.', '-')}`;
}

// One line for frontmatter and llms.txt: the Play text (written as a short
// summary) when `## Short` exists, else the opening paragraph.
export function summarize(notes) {
  const source = notes.hasShort ? notes.play : notes.appStore.split(/\n\s*\n/)[0];
  const line = source.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (line.length <= SUMMARY_LIMIT) return line;
  return `${line.slice(0, SUMMARY_LIMIT).replace(/\s+\S*$/, '')}…`;
}

// Store text is plain paragraphs and "- " bullets, which is already markdown;
// it passes through as the post body. Strings are JSON-quoted (valid YAML).
export function buildPost({ tag, source, date }) {
  const notes = parseReleaseNotes(source);
  const summary = summarize(notes);
  const title = `FUTO Notes ${tag.slice(1)}`;
  const markdown = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `versions: [${JSON.stringify(tag)}]`,
    `date: ${date}`,
    `summary: ${JSON.stringify(summary)}`,
    '---',
    '',
    notes.appStore,
    '',
    '[Download FUTO Notes](/#download)',
    '',
  ].join('\n');
  const llmsLine = `- [${title}](${SITE}/blog/${postSlug(tag)}.md): ${date} — ${summary}`;
  return { markdown, llmsLine, title };
}

// Newest first: the new line goes above the first existing post line.
export function insertLlmsLine(llms, line) {
  const lines = llms.split('\n');
  const at = lines.findIndex((l) => l.includes(`${SITE}/blog/`) && !l.includes('/blog.md'));
  if (at === -1) return null;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

export async function publishWebsitePost({ tag, env, fetchImpl = fetch, readNotes, today, log }) {
  if (!STABLE_TAG_PATTERN.test(tag ?? '')) {
    log(`Skipping: "${tag}" is not a stable vX.Y.Z tag.`);
    return 'skipped';
  }
  const token = env.WEBSITE_REPO_TOKEN;
  if (!token) {
    throw new Error(
      `WEBSITE_REPO_TOKEN is not set, so no website post was published for ${tag}. Set the CI variable (project access token, api scope on the website repo) and re-run the job.`,
    );
  }

  const api = `${env.CI_API_V4_URL || 'https://gitlab.futo.org/api/v4'}/projects/${encodeURIComponent(env.WEBSITE_PROJECT || 'futo-notes/website')}`;
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${api}${path}`, {
      ...init,
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
    });
    if (res.status !== 404 && !res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res;
  };
  const rawFile = (file) => call(`/repository/files/${encodeURIComponent(file)}/raw?ref=main`);

  const postPath = `src/content/blog/${postSlug(tag)}.md`;
  if ((await rawFile(postPath)).status !== 404) {
    log(`Skipping: the website already has ${postPath}.`);
    return 'exists';
  }

  const llmsRes = await rawFile('public/llms.txt');
  if (llmsRes.status === 404) throw new Error('public/llms.txt is missing on the website repo.');
  const llms = await llmsRes.text();
  if (llms.includes(`/blog/${postSlug(tag)}.md`)) {
    log(`Skipping: public/llms.txt already lists ${postSlug(tag)}.`);
    return 'exists';
  }

  const { markdown, llmsLine, title } = buildPost({
    tag,
    source: readNotes(releaseNotesPath(tag)),
    date: today,
  });
  const nextLlms = insertLlmsLine(llms, llmsLine);
  if (!nextLlms) throw new Error('No blog entries found in public/llms.txt to insert above.');

  const mr = env.WEBSITE_RELEASE_MODE === 'mr';
  const branch = mr ? `release-post-${tag}` : 'main';
  const commit = {
    branch,
    ...(mr && { start_branch: 'main' }),
    commit_message: `Add the ${title} release post\n\nPublished by the futo-notes tag pipeline from ${releaseNotesPath(tag)}.`,
    actions: [
      { action: 'create', file_path: postPath, content: markdown },
      { action: 'update', file_path: 'public/llms.txt', content: nextLlms },
    ],
  };
  const done = await (
    await call('/repository/commits', { method: 'POST', body: JSON.stringify(commit) })
  ).json();

  if (mr) {
    const made = await (
      await call('/merge_requests', {
        method: 'POST',
        body: JSON.stringify({
          source_branch: branch,
          target_branch: 'main',
          title: `Add the ${title} release post`,
          remove_source_branch: true,
        }),
      })
    ).json();
    log(`Opened ${made.web_url} for ${title}; merge it to publish.`);
    return 'mr';
  }
  log(
    `Committed ${title} to website main (${String(done.id).slice(0, 8)}); Cloudflare deploys it.`,
  );
  return 'committed';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flag = process.argv.indexOf('--tag');
  const tag = (flag > -1 ? process.argv[flag + 1] : '') || process.env.CI_COMMIT_TAG;
  publishWebsitePost({
    tag,
    env: process.env,
    readNotes: readRepoFile,
    today: new Date().toISOString().slice(0, 10),
    log: (m) => process.stdout.write(`${m}\n`),
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
