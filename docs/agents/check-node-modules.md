# check-node-modules

Moved here verbatim from `justfile-notes.md`.

A fresh worktree has no `node_modules`, and the first JS recipe `check` reaches dies with
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found` — an error that names a
binary, not the missing install (pc_40406aa84bc1). Not an auto-install: `check` is a gate,
and installing behind your back changes what it just verified. `check` deliberately does
NOT depend on `editor-deps`, even though every other recipe `editor-deps` guards does:
`editor-deps` self-installs (`pnpm install`) on a missing/stale `node_modules`, which is
exactly the behind-your-back mutation this forbids for a gate. The guard only
refuses and tells you the command; it never runs it for you. Three independent fixes for
this same papercut once landed on parallel MR stacks (mr-298, mr-318, mr-320); the
duplicates were later collapsed, so `check-node-modules` is now the one guard on `check`.

`check-node-modules` (scripts/check-node-modules.mjs) also guards RC-69: for every entry in
`patchedDependencies` it verifies the patch is APPLIED in every installed copy the app
resolves (`node_modules/<pkg>`, each workspace package's link, and every `.pnpm/*/node_modules/<pkg>`
link). An INCREMENTAL `pnpm install` over an existing `node_modules` can link a
`<pkg>_patch_hash=<hash>` directory holding the unpatched package, or keep an older patch when
a patch file is extended, so a dev or agent checkout silently runs unpatched code; CI installs
fresh and never sees it. It is a pure-JS, read-only check (each hunk's post-image must be present
in the installed file, the question `git apply --check --reverse` answers, without needing git or
`patch`), ~50 ms. It runs from `check` (so `prepush`) and after `just install`; the pre-push hook that once ran it was removed in 72096a0b.
Recovery it prints: `rm -rf node_modules && pnpm install`.
