## Android — IME

| Spec line | Verdict | Evidence |
|---|---|---|
| Backspace on an empty note must not crash the renderer | PASS | Resolved upstream (FUTO Keyboard fix, recorded history); backspace‑on‑empty exercised against the Milkdown bundle `[interactive]` (empty‑item deletes) and on the claimed emulator `[device]` |
| Typing free of IME/caret glitches on every WebView | PASS on the modern tier + GAP | Emulator typing smoke clean under Milkdown `[device]`; the recorded github#8 old‑WebView‑tier Gap stands; per decision D8 there is deliberately no formal keyboard matrix — the dogfood period (#110) is the IME exposure |

---
