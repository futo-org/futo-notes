# Text-first editor production rebuild

Planning decisions recorded, 2026-10-29. The detailed implementation contract is
[Build the production text-first editor engine with store-owned recovery](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283),
GitLab issue #283, published with `ready-for-agent`. This file preserves the agreed planning
decisions and evidence; the issue owns the implementation spec. Child tickets are not yet
approved or published.

## Accepted direction

- Plan the complete replacement, detail and execute the Rust editor engine plus store and
  recovery integration first, then platform parity and cutover (round 1, 1A).
- Preserve source bytes outside the edit and keep markdown rules in Rust. Native mobile and
  CodeMirror 6/WebAssembly desktop hold display text only. See ADR-0011.
- Distinguish process death from device crash/power loss: only the edit in flight may be lost
  on process death; successful durable flushes survive power loss. Validate an initial
  100 ms durability-window target on devices (round 1, 2A; ADR-0012).
- Preserve shipped sync adoption and conflict behavior. CRDTs and collaboration are future
  work, not a prerequisite or a reason to redesign focused-editor adoption now (round 1, 3A).
- Use Bootcamp drills incrementally by risk. Defer the large campaigns until they can be
  divided among workers; do not make them a prerequisite to every useful milestone. Known
  data-loss failures still block acceptance of the behavior they affect (round 1, 4A).
- Persistent undo is deferred. Existing note identity, rename, delete, dev/prod isolation,
  atomic write and push-first sync rules remain in force.

## Engine and presentation responsibilities

Rust owns both source bytes and markdown meaning: block/inline classification, editing rules,
source-to-display correspondence and the changes a renderer applies. A renderer owns native
input mechanics, layout, fonts, colors and drawing from that description. It holds display
text only and contains no markdown parser or duplicate formatting decisions.

Deleting an existing fence delimiter can change the interpretation of the remainder of a
note without editing those later bytes. Ordinary local input keeps bounded synchronous work;
a large semantic change may finish progressively in the background. The displayed text and
position mapping remain consistent for subsequent input, stale results cannot overwrite newer
edits, and source-byte locality still holds (round 2, 6 accepted).

## Recovery failure and edit completion

If the recovery log cannot accept another edit, pause new edits, retain the current draft as
copyable text and surface failure. Do not enter a silent RAM-only editing mode. A failed
markdown checkpoint with a healthy recovery log follows existing save/leave rules rather
than automatically pausing input (round 2, 5 accepted).

Already displayed edits cannot be reclassified as in flight merely because they are queued
for a desktop log-stream timer. Define and test explicit edit sequence acknowledgements in
the implementation spec; distinguish process-recoverable appends from durable flushes.

## Agreed testing interfaces

- Public editor session: input, composition, commands, selection, undo, exact source bytes
  and display changes applied to a reference view.
- Public store workflows: save/recover, outside writes, rename/delete and conflict copies,
  with a controllable clock and fault-injecting filesystem.
- Small platform checks: native bindings and WebAssembly preserve text, offsets and results.

Exercise real editing and recovery behavior through those interfaces. Keep tests independent
of private parser or storage representation (round 2, 7 accepted). Work counters provide cheap
regressions; timing claims require the real target device and declared build conditions.

## Proposed build sequence

1. A complete narrow path: open exact text, edit through the session, apply display changes,
   undo/redo, checkpoint and recover. Include the store from this first working slice.
2. Expand editing behavior: Unicode positions, hidden-format affinity, composition and
   autocorrect, list/newline/delete rules, paste and exact history, with portable regressions.
3. Complete engine-owned markdown and command parity, including container parsing, tables and
   large semantic updates. Carry the spec's behavior forward, with only accepted changes such
   as no whole-note respelling.
4. Complete store lifecycle and outside-write coverage: failure/retry, crash-then-sync/restore,
   rename/delete, stale bases and conflict parking. Introduce these checks with the relevant
   earlier slices; this final pass closes coverage rather than first adding recovery.
5. Validate the agreed engine behavior through native and WebAssembly bindings, use small
   real-platform checks throughout, and measure the typing/durability targets on devices.

The detailed spec and tickets will turn this sequence into independently verifiable behavior
slices with acceptance criteria and blocking relationships. Full renderer parity and cutover
follow; detailed renderer sequencing and large Bootcamp campaigns are later planning work.

## Working baseline and evidence

Production branch/worktree: text-first-editor-rebuild, created from origin/main at
`a3beb27e6baf559f864ee0930c59171eb88c3916`. The spike remains separately available on
text-first-editor at `79cd74e16b3a4bcf5b05bfcce6f1d90a04cda9da`; its unmerged headless fixes
also need review when extracting regression cases.

The spike's proof report, parity map and parked Bootcamp are inputs to this plan. Import
useful test inputs and findings deliberately. The roughly 249-million-case fuzz pass was on
`b8fbe2ac9919ba9f1941ccbad07791c5eb5cdd04`, not the eventual production engine. The old
17-60 engineer-week parity estimate covered missing work on the spike, not the entire
production rebuild; estimate the new work after scope and milestones are specified.

The later proof and Bootcamp replace the original proposal's July-code reuse and calendar
roadmap. Their fixed design promises carry forward, but Bootcamp's proposed graduation
thresholds have not been accepted wholesale. Its old verdict-week/Milkdown-repair detour is
obsolete after choosing this direction.

## Next planning output

Create a dependency-ordered child-ticket breakdown from issue #283 for review before
publishing the tickets. Resolve implementation choices from existing owners, specs and evidence rather
than asking the maintainer to choose data structures or parser internals. Preserve current
supported text-file behavior; hostile-file tests must not silently expand the project into
editing arbitrary binary or non-UTF-8 files.
