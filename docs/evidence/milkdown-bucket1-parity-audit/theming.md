## Theming

| Spec line | Verdict | Evidence |
|---|---|---|
| Editor follows app theme; desktop `data-theme`, native `setTheme` over the bridge | PASS | `[parity]` "token colours come from the theme, and follow it"; `[milkdown]` initialize applies theme; `setTheme` flips `data-theme` `[probe]` |
| Native embed paints no background of its own; both hosts render the WebView transparent | PASS | Page‑level `editor.html` rule, engine‑independent; body background transparent under Milkdown `[probe]`; host halves unchanged |
| Legacy Android unlayered text‑color fallback (Chromium < 99) | PASS | `editor.html`‑level, engine‑independent; `[floor]` legacy‑WebView rewrites cover both engines |
| Chromium 80 floor: `replaceAll` shim, `Array.prototype.at` shim, `textContent` over `replaceChildren` | PASS | Written for Milkdown by T10 (#107); `[floor]` deletes each shim and proves the editor needs it |
| The floor is a property of the built bundle; post‑floor built‑ins shimmed or fail the audit | PASS | `[floor]` bundle audit |
| Engine support decided by capability, never a version number | PASS | T10; EditorEngineSupport.kt preflight tests `[shell]` |
| "Mounted" = the engine came up (`window.__futoEditorMounted`), not the host API | PASS | Line written for Milkdown (T10); src/editor-embed/main.ts; `[floor]` |
| Update‑WebView notice replaces a blank pane; rest of app works; Back needs no save | PASS | Android‑native, engine‑independent; T10 verified; `exitWithoutEditor` `[shell]` |
| Notice names the Chromium major + provider package | PASS | T10 `[shell]` |
| iOS needs no gate | PASS | Deployment floor argument unchanged |
| minSdk 28 | PASS | apps/android/app/build.gradle.kts unchanged |

The recorded Gap (an engine that mounts and then throws inside a later parse shows a blank pane)
stands — GAP, T10's own finding.
