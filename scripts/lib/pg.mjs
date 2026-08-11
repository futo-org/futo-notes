// Postgres access for the QA tooling, ONE implementation.
//
// Run a tiny pg script with bun from the sync-server repo (its node_modules has
// `pg`), so nothing on the host needs psql — the two consumers (scripts/qa.mjs
// and tests/lib/sync-test-server.mjs) both talk to per-worktree databases, and a
// second copy of this would be one more place to get the URL wrong.
import { spawnSync } from 'node:child_process';

const SCRIPT =
  "const {default:pg}=await import('pg');" +
  'const c=new pg.Client(process.env.QA_PG_URL);await c.connect();' +
  'try{await c.query(process.env.QA_PG_SQL)}finally{await c.end()}';

/**
 * @param {string} repo — futo-notes-server checkout (supplies `pg`)
 * @param {string} url — full connection URL, database included
 * @param {string} sql
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function pgQuery(repo, url, sql) {
  return spawnSync('bun', ['-e', SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, QA_PG_URL: url, QA_PG_SQL: sql },
  });
}

/** Machine-level Postgres, database omitted. Both consumers honor the override. */
export const PG_BASE =
  process.env.FUTO_NOTES_QA_PG || 'postgres://futo_notes:futo_notes@localhost:5433';
