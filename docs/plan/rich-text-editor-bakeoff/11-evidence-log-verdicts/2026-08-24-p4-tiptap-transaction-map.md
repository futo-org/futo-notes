### 2026-08-24 — P4 TipTap transaction-to-patch map — kill

- **Revision:** `poc/tiptap-transaction-patch` at `6febad67`.
- **Positive boundary:** a Lezer-backed exact inline map handled real
  ProseMirror text insertion, Markdown escaping, bold/italic/link add, full and
  partial mark removal, and nested wrappers without invoking a serializer.
- **Counterexample:** deterministic seed `0x5eed2026` found a non-planar
  crossing `AddMarkStep` at transaction 12. Minimized source `**mma** de` plus
  italic over `ma d` makes bold and italic intervals cross. Splitting/reopening
  either the existing or new wrapper while preserving the original `**` bytes
  reparses to a different ProseMirror document.
- **Why this is the fixed kill:** an equivalent spelling can be manufactured as
  `**m***__ma__ d*e`, but it changes part of the pre-existing bold marker to
  `__`. That is normalization of syntax the transaction did not edit—the exact
  fallback P4 forbids, and the same tier-3 behavior as P3 at a smaller scope.
- **Verification:** five focused tests preserve both the minimized case and the
  seeded search; formatting/lint and `just build` passed. The exact discriminator
  was
  `pnpm exec vitest run tests/editor-gauntlet/transactionPatchMapper.test.ts --reporter=verbose`,
  followed by
  `pnpm exec eslint tests/editor-gauntlet/transactionPatchMapper.ts tests/editor-gauntlet/transactionPatchMapper.test.ts`
  and `just build`. At `6febad67`, the mapper SHA-256 is
  `c5f80a9ab3300cd6256af8cd8995d056ca676f3b53d7d7e63b52acf59f99ea55`
  and its test SHA-256 is
  `f966e01a788e1b678eb44376d663d9239dbfa4de6b9ccbc78c3078bcfc3856f4`.
- **Verdict:** **kill**, recorded by Codex. P3 is therefore activated as the
  sequence requires.
