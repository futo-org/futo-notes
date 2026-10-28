## 5. What to delete

- `.agent/trace.jsonl`, `TRACE_FILE` and `append_trace` (`main.rs:90`, `875-892`). Nothing but
  audit scripts reads the file.
- `.agent/drive/*.json` and the pretty whole-run `writeFileSync` (`jev-drive.mjs:1206-1210`).
  Also the per-turn `observation` and `state` duplicates: the observation lives in the step's
  `result`, and Jev's state lives in `turn.request`.
- `session_handed_back`'s whole-file scan (`main.rs:1437-1464`).
- The harness copies: `tool-eval/run.mjs:108,171` turn dumps. The harness copies the run file
  instead. Fix `diagnose.mjs:52` to **copy `.agent/runs/` into `runDir`** before it wipes.
- Stale text: SKILL.md:61 ("every question and probability"), SKILL.md:125, commands.md:239,
  justfile:718, design doc :368, and the `emu-logs` tags `FutoSearch` and `FutoToolbarDBG`.
- Later: the page's unbounded dependence on `__MCP_CONSOLE_LOGS__` goes away once §3.3 item 3
  lands. That buffer belongs to the plugin, so leave it alone.

---
