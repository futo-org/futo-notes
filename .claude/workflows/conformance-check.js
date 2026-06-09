export const meta = {
  name: 'conformance-check',
  description:
    'Verify the note rules (filename/tag/image) match bit-for-bit across TS and Rust, then adversarially fuzz for new divergences.',
  whenToUse:
    'Run on every change to packages/shared/{filename,tags,sync}.ts or crates/futo-notes-model. Proves the single-source rule port has not drifted.',
  phases: [
    { title: 'Verify', detail: 'fixtures fresh + TS + Rust conformance suites green' },
    { title: 'Fuzz', detail: 'adversarial inputs diffed Rust-vs-TS, one agent per landmine' },
  ],
}

// ── Phase 1: deterministic conformance ──────────────────────────────────
//
// The golden fixtures in tests/conformance/*.json are generated from the TS
// reference; both Vitest and the Rust model crate read them. This phase
// confirms (a) the fixtures aren't stale vs the TS source and (b) both
// language suites pass.
phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['fixturesFresh', 'tsPass', 'rustPass', 'notes'],
  properties: {
    fixturesFresh: { type: 'boolean', description: 'generate.mjs --check exits 0' },
    tsPass: { type: 'boolean', description: 'just test-shared passes' },
    rustPass: { type: 'boolean', description: 'cargo test -p futo-notes-model passes' },
    notes: { type: 'string' },
  },
}
const verify = await agent(
  `From the repo root, run these three commands and report the result of each as a boolean:
   1. \`pnpm exec tsx tests/conformance/generate.mjs --check\`  (fixturesFresh = exit 0)
   2. \`just test-shared\`  (tsPass = all tests pass)
   3. \`cargo test -p futo-notes-model\`  (rustPass = conformance tests pass)
   Do NOT modify any files. Summarize failures verbatim in notes.`,
  { label: 'verify:conformance', phase: 'Verify', schema: VERIFY_SCHEMA },
)

if (verify && (!verify.fixturesFresh || !verify.tsPass || !verify.rustPass)) {
  log(`⚠ conformance FAILED — fixturesFresh=${verify.fixturesFresh} ts=${verify.tsPass} rust=${verify.rustPass}`)
  log(verify.notes || '')
  return { verify, fuzz: [], verdict: 'fail' }
}
log('✓ deterministic conformance green; running adversarial fuzz')

// ── Phase 2: adversarial fuzz (one agent per landmine) ───────────────────
//
// Each agent invents fresh inputs in its category, computes the TS reference
// output (via tsx against packages/shared), computes the Rust output (via a
// throwaway `cargo test`-style call into futo-notes-model), and reports any
// divergence. Inputs that legitimately differ by representation
// (extractHeaderTagBlock byte vs UTF-16 offset on NON-ASCII) must compare
// `tags` + `remainder` only — call that out, don't flag it.
phase('Fuzz')
const LANDMINES = [
  { key: 'emoji-control', focus: 'sanitizeTitle / validateTitle with emoji, ZWJ sequences, control chars, RTL, combining marks near the 200-UTF-16-unit length limit' },
  { key: 'code-fences', focus: 'extractTags with nested ```/~~~ fences, unclosed fences to EOF, info strings, inline-code backtick runs, tags adjacent to punctuation/emoji' },
  { key: 'paths', focus: 'validateFolderPath / pathDepth with ../ traversal, ./ , double-slash, depth > 10, Windows-reserved components, mixed case' },
  { key: 'tag-grammar', focus: 'normalizeTagName / isValidTagName / tagRegexMatches with leading #s, whitespace runs, uppercase, hyphen/underscore edges, 50/51-char boundary' },
]
const FUZZ_SCHEMA = {
  type: 'object',
  required: ['category', 'casesRun', 'divergences'],
  properties: {
    category: { type: 'string' },
    casesRun: { type: 'number' },
    divergences: {
      type: 'array',
      items: {
        type: 'object',
        required: ['input', 'ts', 'rust', 'isRealBug'],
        properties: {
          input: { type: 'string' },
          ts: { type: 'string' },
          rust: { type: 'string' },
          isRealBug: { type: 'boolean', description: 'false if a documented representation difference (e.g. non-ASCII byte offset)' },
        },
      },
    },
  },
}
const fuzz = await parallel(
  LANDMINES.map((m) => () =>
    agent(
      `Adversarially fuzz the FUTO Notes rules for the "${m.key}" landmine: ${m.focus}.
       Invent ~15 fresh inputs (not already in tests/conformance/*.json). For each:
         - Compute the TS reference output by importing from packages/shared/src
           ({filename,tags,sync}.ts) and running it with \`pnpm exec tsx\`.
         - Compute the Rust output from crates/futo-notes-model (write a temporary
           #[test] or a tiny example that prints the result, run with cargo, then
           remove it — leave the tree clean).
         - Diff them. A divergence where TS and Rust differ ONLY because of a
           documented UTF-16-vs-UTF-8 byte-offset (extractHeaderTagBlock.endOffset
           on non-ASCII) is NOT a real bug (isRealBug=false) — compare tags+remainder.
       Report every divergence with input, ts, rust, and isRealBug. Do not modify
       committed files.`,
      { label: `fuzz:${m.key}`, phase: 'Fuzz', schema: FUZZ_SCHEMA },
    ),
  ),
)

const realBugs = fuzz
  .filter(Boolean)
  .flatMap((r) => (r.divergences || []).filter((d) => d.isRealBug).map((d) => ({ ...d, category: r.category })))

log(realBugs.length === 0
  ? '✓ fuzz found no real Rust↔TS divergences'
  : `✗ fuzz found ${realBugs.length} real divergence(s) — rules have drifted`)

return {
  verify,
  fuzz: fuzz.filter(Boolean),
  realBugs,
  verdict: realBugs.length === 0 ? 'pass' : 'fail',
}
