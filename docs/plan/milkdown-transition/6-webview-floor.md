## 6. WebView floor

Run the editor down the existing Chromium tier ladder (start at `futo-api30` / Chromium 83 — see
the emulator-tier notes in memory/github#8 history). Set the floor where it actually breaks; show
the existing update-WebView notice below it. If the floor would rise above currently-supported
devices, stop and ask Justin (support-surface change).

### T10 outcome (#107, done)

**The floor stays at Chromium 80** — the github#8 support surface is unchanged, so nothing needed
Justin's call. Two things had to be fixed to keep it there.

Measured on the three tier-ladder AVDs, each a real System WebView:

| AVD | Android | WebView | Milkdown |
|---|---|---|---|
| `futo-api28` | 9 | Chromium 66 | update-WebView notice (ES2020 preflight) |
| `futo-api29` | 10 | Chromium 74 | update-WebView notice (ES2020 preflight) |
| `futo-api30` | 11 | Chromium 83 | **runs** — render, dark theme, IME typing, toolbar exec, byte-exact round-trip |

Two limits on that ladder, stated rather than papered over. **83 is the lowest
engine that runs at all** and no stock image ships 80–82, so the bottom three
versions of the supported range are reasoned, not measured — sound for the
built-in shims (the method simply does not exist below 92) and untested for CSS.
And **the audit is JS built-ins only**: the bundle's Tailwind output uses `:is()`
/ `:where()` / `aspect-ratio` (Chromium 88) and `color-mix()` (111), which
degrade rather than throw — Chromium 83 rendered every block type correctly,
including dark-theme text at `rgb(250, 250, 250)`, which is the evidence there is.

**1. Milkdown raised the runtime floor to 92, silently.** `@milkdown/transformer@7.22.1` calls
`Array.prototype.at` (Chromium 92) in its serializer stack and its mark-merge pass — every parse
and every save. On Chromium 83 that is `TypeError: this.elements.at is not a function` and a blank
editor pane. The bundle's ES2020 *syntax* target says nothing about this, which is the same trap
`Element.replaceChildren` (86) set during github#8. `editor.html` shims it beside the existing
`replaceAll` shim (non-enumerable, so nothing's `for…in` over an array changes), and
`tests/editor-embed-webview-floor.spec.ts` now holds the whole floor: it deletes each shimmed
built-in and proves the editor still runs, and audits the BUILT bundle for post-floor built-ins no
shim covers.

**2. The update-WebView notice had stopped working, and would not have come back on its own.**
On Chromium 83 the pre-shim build showed a blank pane and *never* showed the notice. Both halves of
the Android gate treated "the bundle is running" as "the editor is up", which CodeMirror made true
by mounting synchronously and Milkdown makes false by creating its editor asynchronously:
`window.FutoEditor` is published, and the bridge `initialized` reply is sent, whether or not
`Editor.make().create()` succeeded behind them. The editor now publishes
`window.__futoEditorMounted` itself (`src/editor-embed/main.ts`, drift-registry
`editor-mounted-global`); `ENGINE_PROBE_JS` reads that, and `initialized` is no longer a shortcut to
`markEngineBooted`. Verified on the device: the same unshimmed build that showed a silent blank
pane now shows the notice, naming Chromium 83 and the provider version.

The notice is recoverable, not latched. Dropping the `initialized` shortcut also dropped the one
thing that could clear a failure a slow boot had earned, so `EditorWebView` now re-probes on any
inbound bridge message while a failure stands (`rescueEngineVerdict`) — it can only ever clear one,
because the probe stays the authority. Reopening the note re-focuses the editor, which posts, which
is exactly the recovery the notice's own "then reopen the note" promises.

Also fixed while there: Milkdown's mount was an unhandled promise rejection, so an engine that
could not start left nothing anywhere. It logs now — which is how the `.at` failure was named on
the device.

Out of scope, found and left alone: `applyExternalContent with unchanged content preserves the
selection` (`tests/editor-embed-milkdown.spec.ts`) is **flaky on this branch already** — 3 failures
in 8 runs with T10's changes stashed. The caret sometimes lands at the end of the document instead
of where it was, which as a product behavior is a sync echo moving the user's cursor mid-typing.
Worth its own ticket.
