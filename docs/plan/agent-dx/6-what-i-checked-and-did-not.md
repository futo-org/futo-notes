## 6. What I checked and did not

Checked: both machines' transcripts end to end with the same script; every worktree's branch,
last commit, merge state, and dirtiness on jfedora; `target/` sizes on both machines; the last 60
pipelines and the per-job durations of the latest green main pipeline; a full cold `just check` in
this worktree (2 m 02 s, green); the papercuts log including which cuts have a matching resolve.

Not checked: Codex's own session logs (`~/.codex/sessions`), which the papercuts show Codex agents
filing from — their friction is in the log, their transcripts are not in this analysis. Not
measured: how often a green `just check` preceded a red pipeline, which would say how much of CI is
catching things local checks cannot. The social-media pass returned almost nothing from the last 30
days (the Reddit backend errored; X had one relevant post), so the outside-reading input is the
essays and tool docs named at the top, not community sentiment.
