# Behavioral Spec — Source of Truth

What FUTO Notes is supposed to *do*, organized by surface. Plain prose, one
behavior per line. This is the source of truth for behavior across all three
apps (Tauri desktop, native iOS, native Android):

- **Before** changing behavior in an area, read `docs/spec/<area>.md` — "better
  not break X."
- **After** establishing or changing a behavior, add or update the line — "now
  Y is true."

A spec line is a requirement, not a test. It exists even when a platform doesn't
satisfy it yet — that's what makes gaps visible.

## Conventions

- A behavior is true on **all platforms by default**. Platform-specific lines
  get a tag: *(Android)*, *(iOS)*, *(desktop)*, or *(native shells)*.
- `→ path` points at the code or learning doc that is the authority, or where
  the behavior is load-bearing.
- `> **Gap:**` marks a known missing or divergent behavior we haven't closed.

## Areas

| File | Surface |
|---|---|
| [app.md](app.md) | Cross-cutting: render lifecycle, data safety, where logic lives |
| [editor.md](editor.md) | The Markdown editor (shared CodeMirror 6 WebView) |
| [list.md](list.md) | Note list, home feed, folder drawer, note/folder ops |
| [nav.md](nav.md) | Navigation / screen stack / drawer |
| [tabs.md](tabs.md) | Desktop multi-tab + keyboard shortcuts |
| [search.md](search.md) | Search |
| [settings.md](settings.md) | Settings (behavior) |
| [settings-visual.md](settings-visual.md) | Settings (visual recreation spec, from desktop/Tauri) |
| [sync.md](sync.md) | E2EE sync |

## Layering (don't confuse these)

- **This** (`docs/spec/`) — behavioral requirements: what the user experiences.
- `tests/conformance/*.json` — TS↔Rust pure-rule parity (filename/tags/image).
- `markdown-spec/cases/*.yaml` — fine-grained editor decoration/cursor fixtures.

These specs reference the lower layers but don't duplicate them.
