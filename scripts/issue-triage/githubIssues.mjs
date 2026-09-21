/**
 * GitHub issues integration for the triage poller.
 *
 * Reads issues from the public mirror (futo-org/futo-notes) with NO credential
 * at all. The repo is public, so an anonymous GET returns the same issues a
 * token would, and "the bot never writes to GitHub"
 * (docs/plan/github-issue-triage.md, "Guardrails") stops depending on a token's
 * scope being set correctly: a request that carries no identity cannot write.
 * This module therefore exposes no write operation at all.
 *
 * It also cannot expire. The fine-grained PAT this module used to carry hit its
 * 30-day lifetime on 2026-08-22 and every poll failed for 11 days, which is
 * what motivated dropping it. The cost is GitHub's unauthenticated budget of 60
 * requests per hour per IP; a 15-minute timer spends 4 (one page each), so the
 * ceiling is ~15x the demand and a breach is reported as such below.
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
 * Explain a 403/429 that is really the unauthenticated hourly budget, so the
 * operator reads "rate limited until 14:05" instead of a bare "GitHub 403" and
 * knows to wait rather than to hunt for a broken credential.
 * @param {{ status: number, headers?: { get(name: string): string | null } }} response
 * @returns {string}
 */
function rateLimitNote(response) {
  if (response.status !== 403 && response.status !== 429) return '';
  const remaining = response.headers?.get('x-ratelimit-remaining');
  if (remaining !== '0') return '';
  const reset = Number(response.headers?.get('x-ratelimit-reset'));
  const until = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
  return until
    ? ` (unauthenticated rate limit exhausted, resets ${until})`
    : ' (unauthenticated rate limit exhausted)';
}

/**
 * Fetch every issue updated at or after `since`, following pagination.
 *
 * `since` (an ISO 8601 timestamp) bounds the request to keep it small; the
 * caller still dedupes against triage state, so re-seeing an edited issue is
 * harmless. Fetches state=all: a bug closed on the mirror between polls should
 * still be surfaced once.
 *
 * @param {{ repo: string, since: string, fetchImpl?: typeof fetch }} params
 * @returns {Promise<Issue[]>}
 */
export async function fetchIssuesSince({ repo, since, fetchImpl = fetch }) {
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

    // No Authorization header on purpose — see the module comment.
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `GitHub ${response.status} on ${url.pathname}${rateLimitNote(response)}: ` +
          detail.slice(0, 200),
      );
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
