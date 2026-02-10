---
name: zulip
description: Fetch messages from FUTO Zulip channels. Use when the user asks about Zulip messages, feedback, bug reports, or wants to check what's been discussed on Zulip.
argument-hint: [channel-name]
allowed-tools: Bash
---

Fetch messages from the FUTO self-hosted Zulip instance and present them to the user.

## Configuration

- **Zulip URL**: https://zulip.futo.org
- **Email**: justin@futo.org
- **API Key**: sourced from `$ZULIP_API_KEY` environment variable (run `source ~/.zshrc` first)

## Instructions

1. Source the API key: `source ~/.zshrc`
2. Fetch messages from the requested channel (default: `notes-app` if no argument given)
3. Use the channel name from `$ARGUMENTS` if provided, otherwise default to `notes-app`

Fetch command:
```bash
source ~/.zshrc && curl -sSX GET -G "https://zulip.futo.org/api/v1/messages" \
    -u "justin@futo.org:$ZULIP_API_KEY" \
    --data-urlencode 'anchor=oldest' \
    --data-urlencode 'num_before=0' \
    --data-urlencode 'num_after=5000' \
    --data-urlencode 'narrow=[{"operator": "channel", "operand": "CHANNEL_NAME"}]'
```

Replace `CHANNEL_NAME` with the target channel.

4. Parse the JSON response and present messages grouped by topic, in chronological order
5. For each message show: **topic**, **sender name**, **timestamp**, and **content** (strip HTML tags for readability)
6. Summarize the key themes/issues at the end

If the response has `found_newest: false`, paginate by using the last message ID as the next anchor with `num_before=0, num_after=5000` until all messages are fetched.

## Zulip API Reference

- **Auth**: HTTP Basic Auth with `email:api_key`
- **Endpoint**: `GET /api/v1/messages`
- **Narrow syntax**: `[{"operator": "channel", "operand": "channel-name"}]`
- **Anchor values**: `oldest`, `newest`, or a message ID
- **Max per request**: 5000 messages
