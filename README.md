# FUTO Notes

FUTO Notes is an offline-first markdown notes app with optional E2EE sync. The app is built to be simple, performant, and intelligent. Your notes app shouldn't get in the way of what you actually want to accomplish. FUTO Notes isn't a place to garden, it's a place to think and remember.

## Sync Server

The sync server lives in a separate repo:

<https://gitlab.futo.org/futo-notes/futo-notes-server>

## Development

New here? See [CONTRIBUTING.md](./CONTRIBUTING.md) for machine setup, then
[AGENTS.md](./AGENTS.md) for architecture and conventions.

## Linux troubleshooting

If the window is blank or crashes during startup, force WebKitGTK's software-rendering path:

```bash
FUTO_NOTES_SOFTWARE_RENDER=1 futo-notes-tauri
```

FUTO Notes enables this workaround automatically when it detects an NVIDIA GPU. An explicit
`WEBKIT_DISABLE_DMABUF_RENDERER` environment value always takes precedence. To test or force the
GPU path despite NVIDIA detection, launch with `FUTO_NOTES_SOFTWARE_RENDER=0`.
