# Testing Roadmap

Testing investments beyond the current suite. Reference for future work, not an action item.

## Near-term: E2E Client+Server Integration (Tier 3)

- Spawn real Hono server in-process, drive Svelte client via Playwright
- Prerequisite: resolve how the Svelte client discovers the sync server URL at runtime (settings UI vs. config injection vs. query param)
- Follow `tests/dashboard.spec.ts` pattern
- Key scenarios: create→sync→verify on server, server change→client pull, conflict visible in UI
- 5 tests estimated

## Near-term: Playwright Visual Regression

- Add screenshot comparison to key flows (open note, edit, search, switch notes)
- Use Playwright's `toHaveScreenshot()` with golden images
- Catches CSS/layout regressions that current tests miss
- Runs on Linux CI only (cheapest, already works)

## Medium-term: Cross-Platform CI

- Add Windows CI runner (WebView2 is the most divergent from Linux/WebKitGTK dev)
- Add macOS CI runner (WKWebView covers iOS-like behavior)
- Run existing Playwright suite on all 3 platforms
- GitHub Actions has both Windows and macOS runners in free tier
- 3 platforms total, not 10 — targets the real WebView engine differences

## Medium-term: Stress & Performance Testing

- Vault with 1000+ notes: sync latency, search latency, memory usage
- Rapid edit cycles: type fast, sync continuously, no data loss
- Server under concurrent load: 10 clients syncing simultaneously
- Codify as benchmarks (not CI gates) so regressions are visible

## Longer-term: Fuzz Testing

- Property-based testing for sync engine: random sequences of create/edit/delete/rename across N clients → all clients converge
- Fuzz `sanitizeFilename` / `sanitizeTitle` / `ensure_safe_note_id` with arbitrary Unicode + control chars
- Use `cargo-fuzz` for Rust path safety functions
- Use fast-check or similar for TypeScript sync engine

## Longer-term: Agent-Based QA

- On release candidates (not every push), use an AI agent to walk through a scripted QA checklist
- Run on 2-3 platforms (Linux + Windows + macOS), not 10
- Supplement deterministic tests, not replace them
- Agent takes screenshots of each step, flags visual anomalies
- Not a release gate — a review artifact for the developer to scan
