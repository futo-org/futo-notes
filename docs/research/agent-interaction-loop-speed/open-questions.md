## Open questions

- No first-party per-phase wall-clock breakdown exists for any major coding agent. Local
  instrumentation (timestamps around request, first token, last token, tool start/end, settle)
  on a fixed task set would settle where *this* repo's loop spends time.
- Push vs poll has no published magnitude; a controlled comparison (fixed sleep+screenshot vs
  event-driven wait) on the same UI task would.
- Anthropic's programmatic tool calling and Cloudflare Code Mode have no published latency
  numbers, only token and accuracy numbers; wall-clock effect depends on sandbox spin-up.
- Whether Skills measurably shorten trajectories (as AWM/SkillWeaver do in research) has not
  been published by Anthropic.
- AgentOccam raised tokens per step while raising success; the trade-off between observation
  *size* and observation *alignment* is not characterized for GUI a11y trees outside the web.
- Speculative actions' 55% prediction ceiling is domain-dependent; unknown for code editing.
- MCP `resources/subscribe`: which hosts actually surface notifications to the model mid-turn
  (vs only to the UI) is undocumented.
- The Replit "3x faster / 10x cheaper than Computer Use" claim and OpenAI CUA scores need a
  direct read of the vendor pages.
