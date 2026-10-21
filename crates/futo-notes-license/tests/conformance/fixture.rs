//! Loading the golden fixture and the small readers every vector uses.
use super::*;

fn read_json(path: &std::path::Path) -> serde_json::Map<String, Value> {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    match serde_json::from_str(&text).expect("fixture is valid JSON") {
        Value::Object(map) => map,
        other => panic!("{} must hold a JSON object, not {other}", path.display()),
    }
}

/// The fixture is `tests/conformance/license.json` plus every
/// `tests/conformance/license/*.json`, read in filename order and merged by
/// top-level key. A key that appears in several parts must be an array in each;
/// the arrays concatenate in that order (`evaluate` is split this way).
pub(super) fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance");
    let main = root
        .join("license.json")
        .canonicalize()
        .expect("tests/conformance/license.json must exist");
    let mut parts: Vec<_> = std::fs::read_dir(root.join("license"))
        .expect("tests/conformance/license/ must exist")
        .map(|entry| entry.expect("read tests/conformance/license/").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    parts.sort();

    let mut merged = read_json(&main);
    for part in parts {
        for (key, value) in read_json(&part) {
            match (merged.get_mut(&key), value) {
                (None, value) => {
                    merged.insert(key, value);
                }
                (Some(Value::Array(have)), Value::Array(more)) => have.extend(more),
                _ => panic!(
                    "{} repeats `{key}`, which is not an array in both parts",
                    part.display()
                ),
            }
        }
    }
    Value::Object(merged)
}

pub(super) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture case is missing a string `{key}`: {value}"))
}

pub(super) fn instant(raw: &str) -> OffsetDateTime {
    OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|e| panic!("fixture timestamp {raw:?} is not RFC 3339: {e}"))
}

pub(super) fn report(what: &str, failures: Vec<String>, total: usize) {
    assert!(
        failures.is_empty(),
        "{} of {total} {what} vectors in tests/conformance/license.json (and license/) failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// `@name` in a fixture case stands for the activation generated under
/// `namedActivations.name`, so a 350-character base64 blob is written once.
pub(super) fn resolve(fixture: &Value, raw: &str) -> String {
    let mut out = raw.to_string();
    for (_, named) in fixture["namedActivations"]
        .as_object()
        .expect("namedActivations object")
        .iter()
        .filter(|(name, _)| *name != "$comment")
    {
        out = out.replace(text(named, "name"), text(named, "activation"));
    }
    out
}

pub(super) fn fixture_config(fixture: &Value) -> LicenseConfig<'_> {
    LicenseConfig {
        public_key_base64: text(&fixture["keys"]["org"], "publicKeySpkiBase64"),
        pay2_base_url: text(fixture, "testPayBaseUrl"),
    }
}
