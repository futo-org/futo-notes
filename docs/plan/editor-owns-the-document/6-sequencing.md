## 6. Sequencing

One branch, one MR to `main`, commits per concern so a reviewer can read each layer alone. A
v9 bundle is unusable by a v8 host and vice versa, so nothing here ships half-landed (M10);
the dev-build dogfood is on the branch.

1. `feat(editor): tag every document message and add flush (bridge v9)` — §3 + §4, bundle
   tests green, `just bridge-spec` regenerated, desktop untouched. Both native hosts will fail
   to compile/their coverage tests will fail; that is expected at this commit and fixed by the
   next two.
2. `feat(android): the shell keeps a mailbox and never reads the editor` — §5 on Android.
3. `feat(ios): the shell keeps a mailbox and never reads the editor` — §5 on iOS.
4. `docs(spec): editor exits are decided from the mailbox, not a read` — §9, plus
   `apps/ios/AGENTS.md`, `apps/android/AGENTS.md`, `packages/editor/AGENTS.md`,
   `docs/plan/milkdown-transition.md` §10 (strike the #194 entry), drift registry description.
5. `test(qa): exit stories for the mailbox` — §8.
6. `chore(editor): delete the read path` — §10, with the proof-gate output in the commit body.

Do the Android shell before iOS: it has the fewer read sites and its unit tests run on Linux.
The Mac is available over Tailscale for the iOS commit (memory `reference_mac_ssh_ios_builds`:
`justin@100.101.132.29`; codesign needs Justin's own `ssh -t` session, build/test/install you
can run yourself). Keep the worktree on the Mac at the same branch and run `just test-ios-native`
there after every iOS change. Never land a branch where only one host speaks v9.

Commit 6, after everything is green, is the cleanup pass in §10 as its own commit
(`chore(editor): delete the read path`), so the reviewer sees deletions separately from
behaviour. The §10 proof gates must pass before the MR is opened.
