# AGENTS.md - Server Plugins

Each built-in or local plugin should live in its own folder under `apps/server/src/plugins/`.

Required layout:

- `index.ts` for the plugin implementation
- `spec.md` for the behavior spec

`spec.md` is the source of truth for plugin behavior. When changing plugin behavior, update `spec.md` in the same change.
