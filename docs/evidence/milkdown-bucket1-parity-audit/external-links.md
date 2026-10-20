## External links

| Spec line | Verdict | Evidence |
|---|---|---|
| Tap opens the system browser via the `openUrl` bridge (touchend path, scheme‑guarded hosts) | PASS | `[milkdown]` "tapping an external link posts openUrl and never calls window.open"; host‑side guards + `EditorNavigationDecisionTests` unchanged `[shell]` |
| Only the link's own glyphs open it; blank space past the link places the caret | PASS (locked this run) | `[interactive]` "clicking blank space past a link places the caret instead of opening it" — structural in Milkdown: the link is a real `<a>`, so its hit area IS its glyphs |
