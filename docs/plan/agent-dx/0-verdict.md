## 0. Verdict

The harness is already ahead of what the outside writing recommends. Per-worktree slots derive
ports, pooled devices, and sync servers; the spec is the QA oracle; seven architecture gates fail
red on real classes of drift; friction has a committed log; sync runs write a journal. The
remaining cost is concentrated in five places, and every one of them is measurable:

1. **Worktrees have a birth but no death.** 123 worktrees on jfedora and 33 on the Mac. 86 cargo
   `target/` directories here, 19 of them over 100 GB; 50 worktrees untouched since July. `just qa-gc`
   reaps devices, nothing reaps checkouts.
2. **Waiting is hand-rolled.** 15 of the 40 slowest tool calls across both machines are polling
   loops on a GitLab pipeline or a background agent's ledger, each running into the 10-minute tool
   timeout. There is no blocking `ci-wait`.
3. **Nothing is enforced at the harness layer.** Zero Claude Code hooks in the repo or in either
   machine's user settings. Every M-rule is prose plus, at best, a gate that scans instruction files.
   The open major papercut on process-name kills (`pc_44008fcf1d5a`) says exactly this.
4. **Mobile UI driving is the weakest verification link.** 40 of the 135 open papercuts are about
   driving iOS or Android: `axe` not installed, `describe-ios-ui` reporting "screen unknown" on every
   screen under iOS 26.5, a documented `--reboot` flag that `qa.mjs` never implemented, a software
   keyboard that hides for the rest of the boot after HID input, taps that land under the status bar.
5. **Friction is logged but not worked down.** 135 open papercuts, 8 of them major. The last
   `resolve` entry is 2026-08-20. Filing fell from 258 entries in August to 5 in September.

Everything below is either evidence for those five, the list of what an agent needs at each stage
of a task, or a fix with an effort estimate.
