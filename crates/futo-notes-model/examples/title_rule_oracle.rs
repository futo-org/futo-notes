//! Rust oracle for the batched TS↔Rust note-rule differential
//! (`tests/conformance/title-rules-differential.mjs`; run by `just test-rust`).
//!
//! Protocol — one process, one batch, so the differential pays the cargo startup
//! cost exactly once no matter how large the corpus grows:
//!
//!   stdin  `[{ "op": "sanitizeTitle", "input": "CON.bak" }, …]`
//!   stdout `[<answer>, …]`                (same order, one answer per request)
//!
//! `op` names and answer shapes come from the shared dispatcher in
//! `tests/support/rule_ops.rs` — the SAME one the golden-fixture test uses — so
//! the differential can never drift from the goldens' notion of a rule.
//!
//! Named `title_rule_oracle` for continuity: it began as the title-only oracle,
//! and `scripts/drift-registry.json`, the `justfile`, and `.gitlab-ci.yml` all
//! reference this path. It now answers every family the fixtures cover.

use std::io::{self, Read};

use serde::Deserialize;

// `run_op` + helpers, shared with tests/conformance.rs. Also brings
// `futo_notes_model as model` and `serde_json::Value` into scope.
include!("../tests/support/rule_ops.rs");

#[derive(Deserialize)]
struct Request {
    op: String,
    /// Op-specific payload: a bare string for the single-argument rules, an
    /// object for the multi-argument ones (`{ target, allIds }`, …).
    #[serde(default)]
    input: Value,
}

fn main() {
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .expect("read the note-rule request batch from stdin");
    let requests: Vec<Request> =
        serde_json::from_str(&raw).expect("note-rule request batch is a JSON array");
    let answers: Vec<Value> = requests
        .iter()
        .map(|request| run_op(&request.op, &request.input))
        .collect();
    serde_json::to_writer(io::stdout(), &answers).expect("write note-rule answers as JSON");
}
