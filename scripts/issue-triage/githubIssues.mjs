/**
 * GitHub issues integration for the triage poller.
 *
 * Reads issues from the public mirror (futo-org/futo-notes) with a dedicated
 * fine-grained PAT that has ONLY Issues: read permission. That read-only token
 * is what makes "the bot never writes to GitHub" a guarantee by construction
 * rather than by prompt (docs/plan/github-issue-triage.md, "Guardrails"). This
 * module therefore exposes no write operation at all.
 *
 * `convertIssue` is a pure normalizer (external payload → application shape) so
 * it tests without a network; `fetchIssuesSince` is the I/O wrapper.
 */

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/**
 * @typedef {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   author: string,
 *   state: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   url: string
 * }} Issue
 */

/**
 * Normalize a raw GitHub issue object into the small shape the poller needs.
 * @param {object} raw
 * @returns {Issue}
 */
export function convertIssue(raw) {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    state: raw.state ?? 'open',
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

/**
 * The issues endpoint returns pull requests too; a PR carries a `pull_request`
 * key. This repo is a read-only mirror with no PRs today, but filter defensively.
 * @param {object} raw
 * @returns {boolean}
 */
function isPullRequest(raw) {
  return Boolean(raw.pull_request);
}

/**
 * Fetch every issue updated at or after `since`, following pagination.
 *
 * `since` (an ISO 8601 timestamp) bounds the request to keep it small; the
 * caller still dedupes against triage state, so re-seeing an edited issue is
 * harmless. Fetches state=all: a bug closed on the mirror between polls should
 * still be surfaced once.
 *
 * @param {{ repo: string, since: string, token: string, fetchImpl?: typeof fetch }} params
 * @returns {Promise<Issue[]>}
 */
export async function fetchIssuesSince({ repo, since, token, fetchImpl = fetch }) {
  if (!token) {
    throw new Error('missing GitHub token (expected a read-only fine-grained PAT)');
  }

  const collected = [];
  let page = 1;

  // Page until a short page signals the end. per_page=100 is GitHub's max.
  for (;;) {
    const url = new URL(`${GITHUB_API}/repos/${repo}/issues`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('since', since);
    url.searchParams.set('sort', 'created');
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GitHub ${response.status} on ${url.pathname}: ${detail.slice(0, 200)}`);
    }

    const batch = await response.json();
    for (const raw of batch) {
      if (!isPullRequest(raw)) collected.push(convertIssue(raw));
    }

    if (batch.length < 100) break;
    page += 1;
  }

  return collected;
}
