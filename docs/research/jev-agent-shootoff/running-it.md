## Running it

```bash
just tauri-dev                                            # this worktree's desktop app
cargo build -p futo-puppet
just puppet drive 'In `welcome`, make `fox` bold, then undo it. Report line 3.'
cd experiments/agent-skill/tool-eval
node run.mjs --driver jev --set workflows --label <name>  # the sweep (or --set tasks)
# the phone: claim it, run it, then the same sweep against the simulator
eval "$(just qa-claim ios)" && just ios-native
FUTO_PUPPET_TARGET=ios node run.mjs --driver jev --set workflows --label <name>-ios
node compare.mjs claude-workflows <name>
```

The API key is read from `TYPESAFE_API_KEY` or `~/.config/typesafe/api_key`; without one,
`drive` ends at once with `outcome: take-over`, as it does when TypeSafe fails or Jev is stuck twice.
