## 4. Cost

Measured on this Mac, APFS:

| operation | today | proposed |
|---|---|---|
| CLI line append (open + one write + close, 1.5 KB) | 0.04 ms (plus the per-piece writes that tear lines) | 2 lines per call ≈ 0.08 ms |
| Drive trace | one 11 ms pretty write at the end (77 turns, 3.9 MB) | 0.16 ms per 25 KB turn line; compact, so ~half the bytes |
| Acting gate | 5.4 ms scanning 8.6 MB, growing | < 0.1 ms (last line of one file) |
| Retention prune | none | one `readdir` + stat per new run file, < 1 ms |
| Page reply growth | — | events (0–2 KB) + state (≈3–4 KB) over loopback WS / HTTP / adb forward: < 1 ms desktop, ~1–3 ms Android |
| fsync | — | not used (3.5 ms each) |

**Budget: ≤ 2 ms of CLI time and ≤ 3 ms of page time per call.** A desktop Jev turn is
≈ 550 ms and a Claude call through `just agent` is ≈ 1 s, so recording stays under 1%. Check it
with the jev sweeps' `observeMs` median (225 ms on jev-desktop-final) before and after.

---
