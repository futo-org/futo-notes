//! Rust side of the cross-language conformance harness.
//!
//! Reads the SAME hand-reviewed golden fixtures the TypeScript implementation
//! is pinned to (`tests/conformance/{filename,tags,image,preview}.json`) and
//! asserts `futo-notes-model` reproduces every expected output bit-for-bit. If
//! a rule drifts in Rust this test goes red; if it drifts in TS, the Vitest test
//! (`packages/editor/src/conformance.test.ts`) goes red. Rule drift therefore
//! cannot land silently in either language.
//!
//! The goldens pin *reviewed examples*. The much larger generated corpus in
//! `tests/conformance/title-rules-differential.mjs` asks both languages the same
//! questions through the SAME op dispatcher this file uses (`tests/support/
//! rule_ops.rs`) and fails on any disagreement. See `tests/conformance/README.md`.

use std::path::PathBuf;

// `run_op` + helpers, shared with examples/title_rule_oracle.rs. Also brings
// `futo_notes_model as model` and `serde_json::Value` into scope.
include!("support/rule_ops.rs");

fn conformance_dir() -> PathBuf {
    // crates/futo-notes-model/tests/ -> repo root -> tests/conformance
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance")
        .canonicalize()
        .expect("tests/conformance must exist")
}

fn load(name: &str) -> Value {
    let path = conformance_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

/// Compare two JSON values, normalizing integer vs float (serde emits usize as
/// u64, fixtures may carry plain numbers) so `endOffset: 6` matches `6`.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64().zip(y.as_f64()).map(|(p, q)| p == q).unwrap_or(false)
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).map(|w| json_eq(v, w)).unwrap_or(false))
        }
        _ => a == b,
    }
}

fn check_fixture(name: &str) {
    let fixture = load(name);
    let groups = fixture["groups"].as_array().expect("groups array");
    let mut failures = Vec::new();
    let mut total = 0usize;
    for group in groups {
        let op = group["op"].as_str().expect("op string");
        for (i, case) in group["cases"].as_array().expect("cases").iter().enumerate() {
            total += 1;
            let input = &case["input"];
            let expected = &case["expected"];
            let actual = run_op(op, input);
            if !json_eq(&actual, expected) {
                failures.push(format!(
                    "  {op}[{i}] input={input}\n     expected={expected}\n     actual  ={actual}"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} conformance failures in {name}.json (of {total}):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn filename_conformance() {
    check_fixture("filename");
}

#[test]
fn tags_conformance() {
    check_fixture("tags");
}

#[test]
fn image_conformance() {
    check_fixture("image");
}

#[test]
fn preview_conformance() {
    check_fixture("preview");
}

#[test]
fn wikilinks_conformance() {
    check_fixture("wikilinks");
}

/// Cross-language constants gate (architecture-hardening.md PKT-7 gate 3).
/// `tests/conformance/constants.json` also asserted from
/// `apps/tauri/src-tauri/src/filesystem_watcher.rs` (SUPPRESSION_WINDOW_MS —
/// a different crate, not reachable from here) and
/// `src/lib/constantsConformance.test.ts` (TS side of all fields).
#[test]
fn constants_conformance() {
    let fixture = load("constants");
    let expected_max_title_length = fixture["maxTitleLength"]
        .as_u64()
        .expect("maxTitleLength") as usize;
    assert_eq!(
        model::MAX_TITLE_LENGTH, expected_max_title_length,
        "futo_notes_model::MAX_TITLE_LENGTH drifted from tests/conformance/constants.json"
    );
}
