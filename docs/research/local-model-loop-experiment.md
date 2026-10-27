# Experiment: a local model driving the iOS typed-action server

Date: 2026-09-14. Companion to `agent-interaction-loop-speed.md` and
`fast-agent-app-driving.md`, which recommended measuring the loop phase by
phase before building anything. This is that measurement, on the smallest loop
we own end to end.

## Setup

- App: the debug-only iOS `PuppetServer` prototype (uncommitted in worktree
  `agent-device-futo-notes-dc3c07`), 5 static verbs over loopback HTTP, launched
  with `SIMCTL_CHILD_FUTO_PUPPET_PORT=9440` on pooled simulator `futo-qa-4`.
- Model: `granite4.2:8b` (IBM, released 2026-08-25), Q4_K_M, Ollama on Metal,
  100% GPU, `num_ctx` 8192, temperature 0. Apple M5, 24 GB.
- Driver: a ~200-line Node loop (scratchpad, not in repo). Manifest actions
  become tools plus a `done` tool. Every tool call in a response is executed in
  order, so the model may batch. Ten-turn cap.
- Task: open note `brown fox` (seeded `the quick brown fox`), select `brown`
  via find, toggle bold, close find. Oracle: vault bytes equal
  `the quick **brown** fox` and no extra files.
- Each run reseeds the vault and relaunches the app. Screen recorded with
  `simctl io recordVideo`.

## Results

| Variant | Runs | Pass | Wall | Turns | Model time | Action time |
|---|---|---|---|---|---|---|
| Scripted batch, no model | 1 | 1/1 | 0.77 s | 0 | 0 | 0.43 s |
| Granite, no thinking, bare manifest | 3 | 0/3 | 4.9 to 9.8 s | 4 | 96% | 0.2 to 0.4 s |
| Granite, no thinking, described manifest | 3 | 3/3 | 6.6 s | 5 | 96% | 0.27 s |
| Granite, thinking on, described manifest | 1 | 1/1 | 188 s | 5 | 99.8% | 0.42 s |
| Granite, described, prompt asks to batch | 2 | 2/2 | 6.3 to 7.7 s | 5 | 96% | 0.27 s |

Per turn, described manifest, no thinking: 574 to 795 prompt tokens, 16 to 31
output tokens, prefill 50 to 250 ms (prefix cache hit after the first turn),
decode 0.7 to 1.6 s, so about 20 tokens per second. First-turn cold load added
roughly 4.5 s once.

Action costs inside the app: `OpenNote`, `SelectByFind`, `CloseFind` 3 to 15 ms
each. `ToggleBold` 190 to 400 ms because it polls `getContent()` every 50 ms
until the document changes.

## Findings

1. **The bare manifest failed 3 of 3.** Without descriptions the model skipped
   `SelectByFind` and bolded an empty selection, writing `****` at the cursor.
   `ToggleBold`'s self-check passed because the document did change. One
   sentence per verb saying what it needs and what it does fixed it 3 of 3.
   Manifest quality is a correctness lever before it is a speed lever.
2. **Decode, not prefill, is the per-turn floor.** Ollama reuses the prefix, so
   the growing transcript cost 200 ms, while 17 output tokens for one tool call
   cost 700+ ms. A smaller or faster-decoding model cuts the loop; a shorter
   prompt barely does.
3. **The model never batched.** Even when told to emit every call in its first
   response, Granite issued exactly one tool call per turn, every run. The
   loop was five turns for four actions plus `done`. Removing turns has to
   come from the harness or from a model that reliably plans, not from the
   prompt.
4. **Thinking mode is disqualifying at this size.** 2890 reasoning tokens
   before the first action, 188 s total, for the same 5 actions.
5. **Model time is 96% of wall.** App plus transport is about 0.27 s of a 6.6 s
   run. The action server is not the bottleneck at any point.
6. **Self-verifying actions caught nothing here but cost the most.** The bold
   poll is the only action over 15 ms. A bridge method that returns the new
   document would remove it.

## Comparison to prior figures

- Same 4-action flow via agent-device a11y taps (agent-device session): 7.6 s,
  no model in the loop.
- Same flow driven turn by turn by Claude inside Claude Code: about 36 s wall
  for 1.2 s of app time.
- This: 6.6 s with an 8B local model choosing each action, app time 0.27 s.

## Not done

- Cloud comparison (Sonnet 5, Haiku 4.5 through the same loop): blocked on an
  `ANTHROPIC_API_KEY` in the environment.
- Recordings live in the session scratchpad, not the repo.
