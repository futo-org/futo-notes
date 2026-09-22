# QA stories

A QA story is a thing a person does, written so somebody else can do it again on a
real device, plus what was actually seen the last time somebody did. It exists for
behaviour that no automated seam can reach — a camera, a browser sheet the OS owns,
an OS keychain, a real WebView.

Everything that CAN be automated is, and is not written down here: the desktop hosted
flow runs in `tests/cross-platform-sync.mjs`, the engine's own steps in
`crates/futo-notes-sync/tests/hosted_scenarios/`, and each shell's wizard model in its
own unit tests. A story is what is left over.

## What a story file contains

- **Why a person, not a test** — the specific thing automation cannot reach.
- **Setup** — the exact commands, including the ones that are easy to get wrong.
- **The story**, in steps, with what each step should produce.
- **Last run** — date, build, device, and what was seen. Verbatim where it matters.
- **Not proven by this run** — what the story could not show, and why. A limitation
  recorded here is the point; a story that quietly implies full coverage is worse
  than no story.

`docs/spec/` remains the source of truth for behaviour. A story that finds a
divergence records it as a `> **Gap:**` note in the owning spec file, not here.

## Stories

| Story | Surface |
|---|---|
| [hosted-sync-android.md](hosted-sync-android.md) | Log in with FUTO on Android: both wizard shapes, both pairing sides, the account card |
| [hosted-sync-ios.md](hosted-sync-ios.md) | Log in with FUTO on iOS: both wizard shapes, both pairing sides, the account card |
