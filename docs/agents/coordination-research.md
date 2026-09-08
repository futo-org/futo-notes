# Shared agent coordination projects

Researched 2026-09-08 from project documentation and license files. These are
documented capabilities, not locally tested integrations. This note proposes
options; it does not change the repository's agent operating rules.

## Recommendation

Evaluate **Relaycast** as a persistent common messaging service across independent
agent sessions. Try **agentchattr** first if the main goal is a visible room where
the human and terminal agents can talk together. These are fit judgments based on
the capabilities below.

## Candidates

| Project | Documented capabilities | Fit |
| --- | --- | --- |
| [agentchattr](https://github.com/bcurts/agentchattr) | Local browser chat, multiple channels, MCP integration, and support for multiple coding CLIs. Mentions trigger terminal prompts through its wrappers. | Most direct shared-chatroom experience. Automatic wake-ups depend on its terminal integration. |
| [Relaycast](https://github.com/AgentWorkforce/relaycast) | Channels, threads, DMs, search, realtime events, agent identities, MCP, CLI, and SDK access. | Strong candidate for a common service used by independently launched agents. |
| [OpenAgentForum / SwarmRelay](https://github.com/swarmrelay/openagentforum) | Channel messages, persistent identities, MCP, task claims, and standalone deployment. | Another literal agent forum, with additional protocol and commerce features beyond this use case. |

agentchattr uses a standard [MIT license](https://github.com/bcurts/agentchattr/blob/main/LICENSE).
Relaycast uses [Apache-2.0](https://github.com/AgentWorkforce/relaycast/blob/main/LICENSE),
as does [OpenAgentForum](https://github.com/swarmrelay/openagentforum/blob/main/LICENSE).

Relaycast's [self-hosting guide](https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md)
documents a single Node + SQLite process without external services. It is a
single-process deployment; horizontal scaling is not shipped. Message persistence
and live delivery state have different guarantees: some in-memory state resets
on restart.

## MCP Agent Mail license caveat

[MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) has persistent
mailboxes, searchable threads, advisory file reservations, and a human web viewer.
It closely matches coding coordination needs. However, its current
[LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/LICENSE)
includes an OpenAI/Anthropic restriction in addition to MIT text. Do not describe
that version as plain MIT or unrestricted open source.

## Suggested evaluation

Use one private service with project channels, a distinct identity per session,
and threads associated with existing issue IDs. Retain the current issue tracker
as the task authority. Have agents announce scope, report blockers, and post
handoffs or completion details.

Verify two independent sessions can discover each other, exchange messages, and
recover history after restart. Separately verify how each actual agent host
receives notifications or checks unread messages. MCP access alone does not
establish that an idle host automatically starts another turn. This is an
integration question to test before relying on unattended coordination.

## Local Relaycast trial, 2026-09-08

Installed engine, MCP, and SDK version 8.5.4 in
`/home/justin/.local/share/relaycast-trial`, with a loopback-only engine on port
8787 and Codex MCP entry `relaycast-trial`. The directory's `README.md` records
operation, configuration, results, and the local bind-address patch.

Two scripted MCP clients passed identity registration, discovery, channel
messages, thread replies, search, and DM inbox retrieval. Identity tokens,
threads, DMs, and search worked after restarting the engine and MCP clients.
The exact configured Codex launcher initialized and found the workspace.
These are protocol tests; autonomous Codex-to-Codex coordination remains to try.

Live MCP resource notifications failed twice: the MCP package supplies an agent
token to `/v1/ws`, while the same-version engine rejects it with HTTP 401 and
requires agent delivery through the node transport. Explicit inbox reads work.
Keep this limitation visible when evaluating unattended coordination; no
notification fix was applied.
