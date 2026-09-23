#!/usr/bin/env node
// `just ci-wait` / `just mr-status` — block on a GitLab pipeline and get a
// structured answer, instead of a hand-rolled `for i in $(seq 1 28); do curl …;
// sleep 20; done` that runs into the Bash tool's 10-minute cap and is then
// re-issued. 15 of the 40 slowest tool calls in a month of transcripts were
// exactly that loop (docs/plan/agent-dx.md §2.6).
//
//   just ci-wait <sha>            # newest pipeline for that sha
//   just ci-wait mr:291           # the MR's head pipeline (also `!291`)
//   just ci-wait <branch>         # newest pipeline for that ref
//   options: --timeout <min> (45) --interval <sec> (20) --json --no-trace
//   exit: 0 success · 1 failed/canceled/skipped/blocked-on-manual · 2 timeout
//         3 usage/auth/no pipeline
//   just mr-status                # open MRs, oldest first, with head pipeline
//
// Uses curl-equivalent fetch against the REST API with $GITLAB_TOKEN — the
// `glab` CLI cannot authenticate writes from agent shells and mis-parses branch
// names as dates, both filed as papercuts.
import { pathToFileURL } from 'node:url';

export const API = 'https://gitlab.futo.org/api/v4';
export const PROJECT = 'futo-notes%2Ffuto-notes';
export const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);

export function parseTarget(arg) {
  if (!arg) return null;
  const mr = arg.match(/^(?:!|mr:)(\d+)$/);
  if (mr) return { kind: 'mr', iid: Number(mr[1]) };
  if (/^[0-9a-f]{7,40}$/i.test(arg)) return { kind: 'sha', sha: arg };
  return { kind: 'ref', ref: arg };
}

export function exitCodeFor(status) {
  if (status === 'success') return 0;
  if (TERMINAL.has(status)) return 1;
  return 2;
}

export function makeApi(token, fetchImpl = globalThis.fetch) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  return {
    async json(pathAndQuery) {
      const res = await fetchImpl(`${API}/projects/${PROJECT}${pathAndQuery}`, { headers });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`GitLab API ${res.status} — set GITLAB_TOKEN (read_api scope)`);
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
  if (target.kind === 'mr') {
    const mr = await api.json(`/merge_requests/${target.iid}`);
    if (mr.head_pipeline) return mr.head_pipeline;
    const list = await api.json(`/merge_requests/${target.iid}/pipelines?per_page=1`);
    return list[0] ?? null;
  }
  const query =
    target.kind === 'sha' ? `sha=${target.sha}` : `ref=${encodeURIComponent(target.ref)}`;
  const list = await api.json(`/pipelines?${query}&per_page=1`);
  return list[0] ?? null;
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
  },
) {
  const start = now();
  let pipeline = null;
  for (;;) {
    pipeline = await findPipeline(target, api);
    if (pipeline) break;
    if (now() - start > Math.min(timeoutMs, 3 * 60_000)) {
      return { pipeline: null, status: 'not-found', jobs: [], timedOut: false, failed: [] };
    }
    log(`[+${fmtElapsed(now() - start)}] no pipeline yet for ${JSON.stringify(target)}`);
    await sleep(intervalMs);
  }

  let jobs = [];
  for (;;) {
    pipeline = await api.json(`/pipelines/${pipeline.id}`);
    jobs = await api.json(`/pipelines/${pipeline.id}/jobs?per_page=100`);
    const sum = summarizeJobs(jobs);
    if (TERMINAL.has(pipeline.status)) break;
    log(
      `[+${fmtElapsed(now() - start)}] pipeline ${pipeline.id} ${pipeline.status} — ${sum.done}/${sum.total} jobs done`,
    );
    if (now() - start > timeoutMs) {
      return { pipeline, status: pipeline.status, jobs, timedOut: true, failed: sum.failed };
    }
    await sleep(intervalMs);
  }

  const failed = summarizeJobs(jobs).failed;
  if (withTrace) {
    for (const job of failed) job.traceTail = tailLines(await api.text(`/jobs/${job.id}/trace`));
  }
  return { pipeline, status: pipeline.status, jobs, timedOut: false, failed };
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
  if (r.status === 'manual') L.push('', 'blocked on a manual job — a human has to start it');
  return L.join('\n');
}

export function formatMrLine(mr) {
  const state = mr.draft ? 'draft' : 'ready';
  const pipe = mr.head_pipeline?.status ?? 'no-pipeline';
  const conflicts = mr.has_conflicts ? ' CONFLICTS' : '';
  return `!${String(mr.iid).padEnd(5)} ${state.padEnd(6)} ${pipe.padEnd(9)} ${String(mr.created_at ?? '').slice(0, 10)}  ${String(mr.source_branch).slice(0, 34).padEnd(34)} ${String(mr.title).slice(0, 60)}${conflicts}`;
}

export async function mrStatus(api, { log = (s) => process.stdout.write(s + '\n') } = {}) {
  const list = await api.json(
    `/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100`,
  );
  log(`IID    STATE  PIPELINE  CREATED     BRANCH                             TITLE`);
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
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    process.stderr.write('GITLAB_TOKEN is not set — the pipelines API answers 403 anonymously\n');
    process.exit(3);
  }
  const api = makeApi(token);

  if (cmd === 'mr-status') {
    await mrStatus(api);
    return;
  }
  if (cmd !== 'wait') {
    process.stderr.write(
      'usage: ci-wait.mjs wait <sha|mr:N|branch> [--timeout min] [--interval sec] [--json] [--no-trace] | ci-wait.mjs mr-status\n',
    );
    process.exit(3);
  }
  const target = parseTarget(flags._[0]);
  if (!target) {
    process.stderr.write('usage: just ci-wait <sha|mr:N|branch>\n');
    process.exit(3);
  }
  const result = await waitForPipeline(target, {
    api,
    timeoutMs: Number(flags.timeout ?? 45) * 60_000,
    intervalMs: Number(flags.interval ?? 20) * 1000,
    log: (line) => process.stderr.write(line + '\n'),
    withTrace: flags['no-trace'] !== true,
  });
  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(formatResult(result) + '\n');
  if (!result.pipeline) process.exit(3);
  process.exit(result.timedOut ? 2 : exitCodeFor(result.status));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  });
}
