## 7. Baselines (run SECOND; ~2–3 days)

Run the split-torture matrix against the two existing editors before any new
code:

- **Current CM6** (main): quantifies today's pain as a number instead of an
  anecdote, and turns the bold-split report into failing regression cases.
- **Current TipTap branch** (`codex/tiptap-desktop`, worktree at
  `~/Developer/futo-notes-tiptap-desktop`): expected to pass most of the
  matrix (its Enter-inside-bold behavior is the reference), giving the
  quality bar the winner must meet. Note the branch is ~698 commits behind
  main; run it in its own worktree, do not rebase it for this.
