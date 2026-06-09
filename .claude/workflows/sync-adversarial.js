export const meta = {
  name: 'sync-adversarial',
  description:
    'Adversarially stress the E2EE sync orchestrator: generate multi-client / crash / concurrent-rename scenarios, run them, and report verdicts.',
  whenToUse:
    'Run after any change to crates/futo-notes-sync (orchestrator/state/client) or the cross-platform sync harness. Complements the deterministic unit + cross-platform suites with fresh adversarial scenarios.',
  phases: [
    { title: 'Baseline', detail: 'existing sync unit + cross-platform suites green' },
    { title: 'Generate', detail: 'one agent per adversarial sync scenario' },
    { title: 'Verify', detail: 'adversarially confirm each scenario verdict' },
  ],
}

// ── Phase 1: deterministic baseline ──────────────────────────────────────
phase('Baseline')
const BASE_SCHEMA = {
  type: 'object',
  required: ['rustPass', 'crossPlatformRan', 'crossPlatformPass', 'notes'],
  properties: {
    rustPass: { type: 'boolean', description: 'cargo test -p futo-notes-sync passes' },
    crossPlatformRan: { type: 'boolean', description: 'just test-cross-platform actually ran (needs Docker + server)' },
    crossPlatformPass: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const baseline = await agent(
  `From the repo root:
   1. Run \`cargo test -p futo-notes-sync\` → rustPass.
   2. Attempt \`just test-cross-platform\` (boots 2 Tauri instances + the E2EE
      server; needs Docker/Postgres). If the infra is unavailable, set
      crossPlatformRan=false and say why in notes — do NOT treat that as a
      failure. If it runs, report crossPlatformPass.
   Do not modify files.`,
  { label: 'baseline', phase: 'Baseline', schema: BASE_SCHEMA },
)
if (baseline && !baseline.rustPass) {
  log('⚠ sync unit tests are RED — fix before adversarial scenarios')
  return { baseline, verdict: 'fail' }
}

// ── Phase 2/3: adversarial scenarios, pipelined (generate → verify) ──────
//
// Each scenario is exercised, then a SECOND independent agent tries to refute
// the verdict (default to refuted=true on uncertainty), so a plausible-but-wrong
// "pass" can't slip through.
const SCENARIOS = [
  {
    key: 'dirty-merge-conflict-copy',
    spec: 'Two clients edit the same note to divergent content with no common merge base, then both push. Expect: one side keeps remote at the original path AND the loser is preserved in a `note (conflict YYYY-MM-DD).md` copy — NEVER silently dropped (plan §4).',
  },
  {
    key: 'crash-mid-sync-recheckpoint',
    spec: 'A first sync uploads many (>50) new notes but the process is killed mid-push. On restart, expect: already-uploaded blobs are NOT re-POSTed as duplicates — the every-50 checkpoint persisted the object map (plan §5).',
  },
  {
    key: 'local-rename-single-put',
    spec: 'A note is moved to a new folder locally (old path gone, new path appears, same basename), then push. Expect: a single PUT reusing the object_id (rename pairing) — NOT a delete + a fresh POST that tombstones and recreates.',
  },
  {
    key: 'concurrent-rename-vs-edit',
    spec: 'Client A renames a note while client B edits its body; both sync. Expect: no data loss — the edit survives and the rename resolves to one canonical path (this is the known concurrent-move edge; report honestly if it does NOT hold).',
  },
  {
    key: 'legacy-app-state-migration',
    spec: 'A vault has a pre-port `.app-state.json` with `e2eeObjectMap` but no `.e2ee-state.json`. On first connect, expect: the map is imported (migrated_legacy=true) so the first sync does NOT re-upload every local note as new.',
  },
]
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['scenario', 'expected', 'actual', 'pass', 'evidence'],
  properties: {
    scenario: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    pass: { type: 'boolean' },
    evidence: { type: 'string', description: 'commands/files that establish the verdict' },
  },
}
const REFUTE_SCHEMA = {
  type: 'object',
  required: ['refuted', 'why'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the pass verdict does NOT hold up' },
    why: { type: 'string' },
  },
}

const results = await pipeline(
  SCENARIOS,
  (s) =>
    agent(
      `Adversarially test this E2EE sync scenario against crates/futo-notes-sync:
       "${s.spec}"
       Prefer driving the real orchestrator logic (unit-level tests against
       futo_notes_sync::orchestrator / state, or the tests/cross-platform-sync.mjs
       harness if Docker is up). Write any temp test, run it, then leave the tree
       clean. Report expected vs actual and a pass boolean with evidence.`,
      { label: `gen:${s.key}`, phase: 'Generate', schema: VERDICT_SCHEMA },
    ),
  (verdict, s) =>
    verdict && verdict.pass
      ? agent(
          `Try to REFUTE this sync verdict (default refuted=true if uncertain):
           scenario "${s.key}" — claimed PASS because: ${verdict.actual}.
           Evidence given: ${verdict.evidence}. Re-derive independently; if the
           data-loss/duplicate/tombstone failure mode could still occur, refute.`,
          { label: `refute:${s.key}`, phase: 'Verify', schema: REFUTE_SCHEMA },
        ).then((r) => ({ ...verdict, refuted: r?.refuted ?? true, refuteWhy: r?.why }))
      : Promise.resolve(verdict),
)

const confirmed = results.filter(Boolean).filter((r) => r.pass && !r.refuted)
const failed = results.filter(Boolean).filter((r) => !r.pass || r.refuted)
log(`sync-adversarial: ${confirmed.length} confirmed, ${failed.length} need attention`)

return {
  baseline,
  confirmed: confirmed.map((r) => r.scenario),
  failed,
  verdict: failed.length === 0 ? 'pass' : 'attention',
}
