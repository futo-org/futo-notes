# Deep dive: visibility — what an agent can see and prove in FUTO Notes

Date 2026-09-24, worktree `elated-kowalevski-3173cb` at `9bc08048`. Read-only. Live evidence is from
this worktree's desktop dev app, driven with `FUTO_AGENT_JEV=off target/debug/futo-agent`. Every
overlay I opened was closed again: Settings, the language listbox, a note context menu, the note
actions menu, Search and Find. The selection is back at 0 and the tabs are unchanged. The native
claims come from reading the source (`AgentActionServer.swift`/`.kt`, `AgentVerbs.*`, the screens).
No simulator or emulator was touched. Overlaps: payload size is sibling (a)'s area and trace
joinability is sibling (b)'s. This file covers only **what gets perceived**.

- [0. Verdict in one paragraph](deep-dive-visibility/verdict.md): what agents see today, and the single derived `ui` block that fixes it
- [1. Behaviour × platform: visible today? provable? what closes it](deep-dive-visibility/behaviour-by-platform.md): the 29 behaviours × desktop, iOS and Android: visible, provable, and the rule that closes each
- [2. The mechanism](deep-dive-visibility/mechanism.md): D1–D5 and C1–C2: how `ui` is derived on each platform, and where it surfaces
- [3. What the agent would see (real interactions; text lines in the audit C1 style)](deep-dive-visibility/agent-view-examples.md): what the agent would see for eight real interactions
- [4. The gate: new UI cannot be silently invisible](deep-dive-visibility/visibility-gate.md): the static and runtime gates that keep new UI visible
- [5. Implementation plan, ordered and test-first](deep-dive-visibility/implementation-plan.md): the steps, in order, test first, and the risks
