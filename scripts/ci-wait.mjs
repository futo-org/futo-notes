#!/usr/bin/env node
// `just ci-wait` / `just mr-status` — block on a GitLab pipeline and get a
// structured answer, instead of a hand-rolled `for i in $(seq 1 28); do curl …;
// sleep 20; done` that runs into the Bash tool's 10-minute cap and is then
// re-issued. 15 of the 40 slowest tool calls in a month of transcripts were
// exactly that loop (docs/plan/agent-dx.md §2.6).
//
//   just ci-wait <pipeline-id>    # exact pipeline in this project
//   just ci-wait <sha>            # newest pipeline for that sha
//   just ci-wait <branch>         # newest pipeline for that ref
//   Numeric names: use sha:<sha> or ref:<branch> to distinguish them from IDs.
//   options: --timeout <min> (120) --interval <sec> (20) --json --no-trace
//            --wait-all (keep waiting after a blocking job fails)
//   exit: 0 success · 1 a blocking job failed, or failed/canceled/skipped/
//         blocked-on-manual · 2 timeout · 3 usage/auth/no pipeline
//
// It returns as soon as any job that is not allow_failure fails, without
// waiting for the rest of the pipeline: a tag pipeline keeps "running" for
// up to an hour after a broken build. A failed API call is retried, not fatal.
// Run it with the Bash tool's run_in_background rather than hand-writing a
// polling loop; that is what this script is for.
//   just mr-status                # open MRs, oldest first
// Merge requests get no pipeline (.gitlab-ci.yml workflow:), so there is no
// MR target: `mr:291` / `!291` is a usage error, not a branch name.
//
// Uses the REST API with $GITLAB_TOKEN, falling back to the configured glab
// credential for gitlab.futo.org when the environment does not supply one.
import { spawnSync } from 'node:child_process';

export const API = 'https://gitlab.futo.org/api/v4';
export const PROJECT = 'futo-notes%2Ffuto-notes';
export const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);

export function parseTarget(arg) {
  if (!arg) return null;
  if (/^(?:!|mr:)\d+$/.test(arg)) return null;
  const pipeline = arg.match(/^(?:pipeline:)?([1-9]\d*)$/);
  if (pipeline && Number.isSafeInteger(Number(pipeline[1])))
    return { kind: 'pipeline', id: Number(pipeline[1]) };
  if (arg.startsWith('ref:')) return { kind: 'ref', ref: arg.slice(4) };
  if (/^sha:[0-9a-f]{7,40}$/i.test(arg)) return { kind: 'sha', sha: arg.slice(4) };
  if (/^[0-9a-f]{7,40}$/i.test(arg)) return { kind: 'sha', sha: arg };
  return { kind: 'ref', ref: arg };
}

export function exitCodeFor(status) {
  if (status === 'success') return 0;
  if (TERMINAL.has(status)) return 1;
  return 2;
}

// Capture both streams: neither a token nor glab's credential diagnostics belong
// in CI output. The caller gets a repair hint without credential contents.
export function resolveToken({ env = process.env, run = spawnSync } = {}) {
  if (env.GITLAB_TOKEN) return env.GITLAB_TOKEN;
  const result = run('glab', ['config', 'get', 'token', '--host', 'gitlab.futo.org'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const token = result.status === 0 ? result.stdout?.trim() : '';
  if (token) return token;
  throw new Error(
    'Set GITLAB_TOKEN (read_api scope) or run glab auth login --hostname gitlab.futo.org',
  );
}

export function makeApi(token, fetchImpl = globalThis.fetch) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  return {
    async json(pathAndQuery) {
      const res = await fetchImpl(`${API}/projects/${PROJECT}${pathAndQuery}`, { headers });
      if (res.status === 401 || res.status === 403) {
        const error = new Error(`GitLab API ${res.status} — set GITLAB_TOKEN (read_api scope)`);
        error.fatal = true;
        throw error;
      }
      if (!res.ok) throw new Error(`GitLab API ${res.status} for ${pathAndQuery}`);
      return res.json();
    },
    async text(pathAndQuery) {
      const res = await fetchImpl(`${API}/projects/${PROJECT}${pathAndQuery}`, { headers });
      if (!res.ok) return '';
      return res.text();
    },
  };
}

export async function findPipeline(target, api) {
  if (target.kind === 'pipeline') return api.json(`/pipelines/${target.id}`);
  const query =
    target.kind === 'sha' ? `sha=${target.sha}` : `ref=${encodeURIComponent(target.ref)}`;
  const list = await api.json(`/pipelines?${query}&per_page=1`);
  return list[0] ?? null;
}

// Every job and trigger job (bridge), across pages. /jobs leaves bridges out,
// and a blocking trigger can fail while the rest of the pipeline runs. Jobs
// land in `into` as each page arrives, so a failure already read survives an
// error on a later page.
export async function listJobs(api, pipelineId, into = []) {
  for (const kind of ['jobs', 'bridges']) {
    for (let page = 1; ; page++) {
      const batch = await api.json(`/pipelines/${pipelineId}/${kind}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitLab API returned no list for ${kind}`);
      into.push(...batch);
      if (batch.length < 100) break;
    }
  }
  return into;
}

export function summarizeJobs(jobs) {
  const counts = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  const done = jobs.filter((j) => TERMINAL.has(j.status) || j.status === 'manual').length;
  return {
    counts,
    done,
    total: jobs.length,
    failed: jobs.filter((j) => j.status === 'failed' && !j.allow_failure),
  };
}

export function tailLines(text, n = 40) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Poll until the pipeline is terminal or the timeout passes.
 * @returns {Promise<{ pipeline: object|null, status: string, jobs: object[], timedOut: boolean, failed: object[] }>}
 */
export async function waitForPipeline(
  target,
  {
    api,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs,
    intervalMs,
    log = () => {},
    now = Date.now,
    withTrace = true,
    waitAll = false,
    maxApiErrors = 10,
  },
) {
  const start = now();
  let apiErrors = 0;
  // A network blip or a 5xx is retried; only auth errors or a run of
  // maxApiErrors failures in a row end the wait.
  const attempt = async (fn) => {
    try {
      const value = await fn();
      apiErrors = 0;
      return { ok: true, value };
    } catch (error) {
      if (error.fatal || ++apiErrors >= maxApiErrors) return { ok: false, error, giveUp: true };
      log(
        `[+${fmtElapsed(now() - start)}] GitLab API error, retrying (${apiErrors}/${maxApiErrors}): ${error.message}`,
      );
      return { ok: false, error };
    }
  };
  const timedOut = () => now() - start > timeoutMs;

  let pipeline = null;
  for (;;) {
    const found = await attempt(() => findPipeline(target, api));
    if (!found.ok) {
      if (found.giveUp) throw found.error;
      if (timedOut())
        return { pipeline: null, status: 'not-found', jobs: [], timedOut: true, failed: [] };
      await sleep(intervalMs);
      continue;
    }
    pipeline = found.value;
    if (pipeline) break;
    if (now() - start > Math.min(timeoutMs, 3 * 60_000)) {
      return { pipeline: null, status: 'not-found', jobs: [], timedOut: false, failed: [] };
    }
    log(`[+${fmtElapsed(now() - start)}] no pipeline yet for ${JSON.stringify(target)}`);
    await sleep(intervalMs);
  }

  let jobs = [];
  let failFast = false;
  const reportedAllowed = new Set();
  for (;;) {
    const id = pipeline.id;
    const partial = [];
    const polled = await attempt(async () => [
      await api.json(`/pipelines/${id}`),
      await listJobs(api, id, partial),
    ]);
    if (!polled.ok) {
      if (!waitAll && summarizeJobs(partial).failed.length) {
        jobs = partial;
        failFast = true;
        break;
      }
      if (polled.giveUp) throw polled.error;
      if (timedOut()) {
        const failed = summarizeJobs(jobs).failed;
        return { pipeline, status: pipeline.status, jobs, timedOut: true, failFast, failed };
      }
      await sleep(intervalMs);
      continue;
    }
    [pipeline, jobs] = polled.value;
    const sum = summarizeJobs(jobs);
    // A blocking failure decides the answer even when the pipeline reports a
    // terminal status, so a failed job under a "success" pipeline exits 1.
    if (sum.failed.length && !waitAll) {
      failFast = !TERMINAL.has(pipeline.status);
      break;
    }
    if (TERMINAL.has(pipeline.status)) break;
    for (const j of jobs) {
      if (j.status === 'failed' && j.allow_failure && !reportedAllowed.has(j.id)) {
        reportedAllowed.add(j.id);
        log(`[+${fmtElapsed(now() - start)}] ${j.name} failed (allowed to fail)`);
      }
    }
    log(
      `[+${fmtElapsed(now() - start)}] pipeline ${pipeline.id} ${pipeline.status} — ${sum.done}/${sum.total} jobs done${sum.failed.length ? `, ${sum.failed.length} blocking failed` : ''}`,
    );
    if (timedOut()) {
      return {
        pipeline,
        status: pipeline.status,
        jobs,
        timedOut: true,
        failFast,
        failed: sum.failed,
      };
    }
    await sleep(intervalMs);
  }

  const failed = summarizeJobs(jobs).failed;
  if (withTrace) {
    for (const job of failed) {
      job.traceTail = tailLines(await api.text(`/jobs/${job.id}/trace`).catch(() => ''));
    }
  }
  return { pipeline, status: pipeline.status, jobs, timedOut: false, failFast, failed };
}

export function formatResult(r) {
  const L = [];
  if (!r.pipeline) return 'no pipeline found';
  L.push(
    `pipeline ${r.pipeline.id} ${r.status}${r.timedOut ? ' (TIMED OUT waiting)' : ''} — ${r.pipeline.web_url ?? ''}`,
  );
  const dur = (j) => (j.duration ? `${Math.round(j.duration)}s` : '-');
  for (const j of r.jobs)
    L.push(
      `  ${j.status.padEnd(9)} ${dur(j).padStart(6)}  ${j.name}${j.allow_failure && j.status === 'failed' ? '  (allowed to fail)' : ''}`,
    );
  for (const j of r.failed) {
    L.push('', `--- ${j.name} (job ${j.id}) last lines ---`);
    L.push(j.traceTail ?? '(trace not fetched)');
  }
  if (r.failFast)
    L.push(
      '',
      `stopped at the first blocking failure; the pipeline is still ${r.status} (--wait-all to keep waiting)`,
    );
  if (r.status === 'manual') L.push('', 'blocked on a manual job — a human has to start it');
  return L.join('\n');
}

export function formatMrLine(mr) {
  const state = mr.draft ? 'draft' : 'ready';
  const conflicts = mr.has_conflicts ? ' CONFLICTS' : '';
  return `!${String(mr.iid).padEnd(5)} ${state.padEnd(6)} ${String(mr.created_at ?? '').slice(0, 10)}  ${String(mr.source_branch).slice(0, 34).padEnd(34)} ${String(mr.title).slice(0, 60)}${conflicts}`;
}

export async function mrStatus(api, { log = (s) => process.stdout.write(s + '\n') } = {}) {
  const list = await api.json(
    `/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100`,
  );
  log(`IID    STATE  CREATED     BRANCH                             TITLE`);
  const rows = [];
  for (const brief of list) {
    const mr = await api.json(`/merge_requests/${brief.iid}`);
    rows.push(mr);
    log(formatMrLine(mr));
  }
  return rows;
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else flags._.push(a);
  }
  return flags;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  const token = resolveToken();
  const api = makeApi(token);

  if (cmd === 'mr-status') {
    await mrStatus(api);
    return;
  }
  if (cmd !== 'wait') {
    process.stderr.write(
      'usage: ci-wait.mjs wait <pipeline-id|sha|branch> [--timeout min] [--interval sec] [--wait-all] [--json] [--no-trace] | ci-wait.mjs mr-status\n',
    );
    process.exit(3);
  }
  const target = parseTarget(flags._[0]);
  if (!target) {
    process.stderr.write(
      'usage: just ci-wait <pipeline-id|sha|branch> (merge requests get no pipeline)\n',
    );
    process.exit(3);
  }
  const result = await waitForPipeline(target, {
    api,
    timeoutMs: Number(flags.timeout ?? 120) * 60_000,
    intervalMs: Number(flags.interval ?? 20) * 1000,
    log: (line) => process.stderr.write(line + '\n'),
    withTrace: flags['no-trace'] !== true,
    waitAll: flags['wait-all'] === true,
  });
  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(formatResult(result) + '\n');
  if (!result.pipeline) process.exit(3);
  if (result.failFast || result.failed.length) process.exit(1);
  process.exit(result.timedOut ? 2 : exitCodeFor(result.status));
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  });
}
