//! The language-catalog accessor: every human sentence the CLI prints comes
//! from `languages/en.json`, the same catalog every other shell reads.
//!
//! Interpolation follows `languages/README.md`: `{name}` inserts a value as
//! plain text (never re-parsed), `{{` and `}}` are literal braces. Protocol
//! identifiers — command names, JSON keys, error codes — are never looked up
//! here.

use std::sync::OnceLock;

use serde_json::Value;

const CATALOG: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../languages/en.json"
));

fn messages() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| {
        let catalog: Value = serde_json::from_str(CATALOG).expect("languages/en.json is JSON");
        catalog["messages"].clone()
    })
}

fn lookup(path: &str) -> Option<&'static Value> {
    path.split('.')
        .try_fold(messages(), |current, segment| current.get(segment))
}

/// The message at `path`. A missing path renders as the path itself, which the
/// catalog test makes unreachable for every literal path in this crate.
pub fn t(path: &str) -> String {
    tf(path, &[])
}

/// The message at `path` with `{name}` placeholders filled from `args`.
pub fn tf(path: &str, args: &[(&str, &str)]) -> String {
    match lookup(path).and_then(Value::as_str) {
        Some(template) => interpolate(template, args),
        None => path.to_owned(),
    }
}

fn interpolate(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(index) = rest.find(['{', '}']) {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        if let Some(after) = tail.strip_prefix("{{") {
            out.push('{');
            rest = after;
        } else if let Some(after) = tail.strip_prefix("}}") {
            out.push('}');
            rest = after;
        } else if let (true, Some(end)) = (tail.starts_with('{'), tail.find('}')) {
            let name = &tail[1..end];
            match args.iter().find(|(key, _)| *key == name) {
                Some((_, value)) => out.push_str(value),
                None => out.push_str(&tail[..=end]),
            }
            rest = &tail[end + 1..];
        } else {
            out.push_str(&tail[..1]);
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_and_literal_braces() {
        assert_eq!(
            interpolate("Delete {noteTitle}?", &[("noteTitle", "a {b}")]),
            "Delete a {b}?"
        );
        assert_eq!(
            interpolate("Write {{count}}", &[("count", "3")]),
            "Write {count}"
        );
        assert_eq!(interpolate("{missing}", &[]), "{missing}");
    }

    /// Every catalog path this crate names literally must exist, so no user
    /// ever sees a raw path instead of a sentence.
    #[test]
    fn every_literal_catalog_path_exists() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut missing = Vec::new();
        let mut checked = 0;
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                // Every quoted literal shaped like a catalog path, whether it is
                // passed to `t` directly or handed through a variable first.
                for prefix in ["\"cli.", "\"sync."] {
                    for (index, _) in text.match_indices(prefix) {
                        let start = index + 1;
                        let Some(length) = text[start..].find('"') else {
                            continue;
                        };
                        let key = &text[start..start + length];
                        if key.ends_with('.')
                            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
                        {
                            continue;
                        }
                        checked += 1;
                        if lookup(key).and_then(Value::as_str).is_none() {
                            missing.push(format!("{}: {key}", path.display()));
                        }
                    }
                }
            }
        }
        assert!(checked > 50, "the scan found only {checked} catalog paths");
        assert!(
            missing.is_empty(),
            "missing catalog messages:\n{}",
            missing.join("\n")
        );
    }
}
