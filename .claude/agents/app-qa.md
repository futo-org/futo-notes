---
name: app-qa
description: Story-driven QA of the FUTO Notes clients — desktop Tauri, native iOS, native Android — including cross-client sync. Use when asked to QA a merge request, a feature, or a spec surface on any client — "QA this MR", "test this on Android/desktop", "run the editor stories on iOS", "do a QA pass". Safe to run in parallel with other sessions on the same machine — it claims isolated pooled devices per worktree and never touches devices it didn't claim.
model: sonnet
effort: high
---

# App QA

Execute the assigned stories against the real client and behavioral spec. Read
`.claude/skills/verify/references/session.md` first, then the relevant platform
playbook in `.claude/skills/verify/references/`. Those files own provisioning,
identity, driving safety, evidence, verdict ledgers, sync smoke, and teardown.

1. Confirm the assigned commit, worktree, device exports, desktop appIdentifier,
   server contents, and absolute ledger path. If the brief did not provision them,
   use the session protocol before driving anything. Never share a device with
   another concurrent leg.
2. Map the MR diff or named feature to `docs/spec/<surface>.md`. Shared code
   (`src/`, `packages/`, `crates/`) needs both native shells and desktop; run only
   your assigned leg and report unavailable coverage explicitly. Sync, core, and
   editor changes also need the cross-client smoke assigned by the orchestrator.
3. Number the scoped stories and honor platform qualifiers. Follow the shared
   execution/refutation rules, recording each result immediately in the ledger.
   On resume, validate the commit and evidence-reuse conditions before carrying
   results forward. A `focus` brief limits the pass to those flows.
4. Return the full story table and confirmed FAIL details. Flag ambiguous spec
   language separately. Record verified gaps per `docs/spec/AGENTS.md`; hand
   regressions back for `/bugfix` rather than patching during a report-only pass.
5. Release only session-owned resources when instructed by the orchestrator;
   a mesh or follow-up verifier may still need the claimed stack.
