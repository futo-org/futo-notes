# Notes shell/session/sync contract rewrite

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/notes-shell-session-sync-rewrite.md
```

## 2. Central lesson

The editor session and sync lifecycle are different owners, but they need one
direct relationship. The former callback graph represented every property and
mutation as a separate dependency, which hid ordering rules among dozens of
forwarders. The replacement passes the session itself to the sync owner:

- `noteSession` owns the loaded id, saved baseline, live draft, validation, and
  serialized saves;
- `syncManager` owns sync health, watcher batching, remote rename/adopt/delete
  reconciliation, and deleted-tab pruning;
- `NotesShell` owns composition, DOM projections, tabs, routing, and layout.

The important boundary is not “component versus helper.” It is “who may decide
whether the open draft is clean, and who may replace or close it.”


## 4. Safety invariants

- A save never treats a missing/destroyed editor as an empty document.
- Opening a note is read-only; CM6 line-ending normalization does not write.
- A title-only edit cannot rename the file during a normal typing pause; body
  edits still persist quickly, and an explicit flush drains unseen editor text.
- Programmatic remote adopts do not increment the local edit version.
- Focused CM6 documents are never replaced; a clean deferred adopt lands on
  blur, while a newly dirty draft wins.
- A deleted open note is closed only after disk absence is authoritative; a
  recreated empty note remains valid, and an unsaved draft remains open.
- Deleted background tabs are pruned only when their files are absent.
- Remote renames retarget tabs before deleted-id pruning.
- Pure local pushes do not trigger a vault rescan or redundant search reindex.
- Sync and save remain asynchronous and never block editor input.


## 5. Failure-derived rules

- A test-only route seed must mark the route loaded before navigation; otherwise
  the route effect correctly reads the absent file and replaces the seed with
  an empty document.
- Sync completion is a four-phase operation: report outcome, project peer
  writes, apply renames, then reconcile/prune. Mixing these phases recreates the
  rename-versus-delete ordering bugs.
- Disk existence, not `updatedIds`, decides whether a deleted id survived. The
  summary combines local pushes and peer pulls, so membership can be ambiguous.
- An empty read following a delete must be followed by an existence recheck.


## 8. Follow-up queue

- The shell still contains desktop tab persistence and native listener setup.
  Those belong to their existing owners only if a future rewrite can delete the
  shell policies rather than wrap them in another callback adapter.
- Fault injection cannot currently prove process death between a session save
  completing and a user-initiated delete. The current delete path cancels the
  timer before deleting; a durable compare-and-swap/delete transaction would
  require a lower-level note-store contract and is out of this rewrite.
