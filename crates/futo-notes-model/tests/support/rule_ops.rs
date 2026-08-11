// The language-neutral note-rule op dispatcher, shared by BOTH Rust-side
// conformance consumers via `include!`:
//
//   * `tests/conformance.rs`            — asserts the hand-reviewed goldens
//     (`tests/conformance/*.json`) against this crate.
//   * `examples/title_rule_oracle.rs`   — answers the batched TS↔Rust
//     differential (`tests/conformance/title-rules-differential.mjs`).
//
// One dispatcher, two callers, on purpose: an op that the goldens exercise but
// the differential cannot reach (or vice versa) would be a silent coverage
// hole, and two hand-maintained `match op` blocks is exactly how that hole
// appears. `include!` rather than a `mod` because an example and an
// integration test are separate compilation units that cannot share a module,
// and this is test scaffolding that must not leak into the shipped lib.
//
// `op` names are the cross-language verbs the fixtures and every other binding
// (TS, Swift, Kotlin) dispatch on — never rename one without updating the
// fixtures, the differential, and the native specs together.

use futo_notes_model as model;
use serde_json::Value;

/// Issue kinds as snake_case strings, matching the TS `kind` union.
fn kinds(issues: &[model::FilenameIssue]) -> Vec<String> {
    issues.iter().map(|i| i.kind.as_str().to_string()).collect()
}

/// A JSON string-array field of an input object → `Vec<String>`.
fn string_vec(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Dispatch a language-neutral op + input → a JSON value comparable to the
/// fixture's `expected` (and to the TypeScript copy's answer).
///
/// `extractHeaderTagBlock`'s `endOffset` is a BYTE offset here and a UTF-16
/// offset in TypeScript, so the representation-independent `remainder` is
/// carried alongside it; callers comparing across languages must ignore
/// `endOffset` for non-ASCII input (the differential does).
fn run_op(op: &str, input: &Value) -> Value {
    let s = || input.as_str().unwrap_or_default().to_string();
    match op {
        "sanitizeTitle" => Value::from(model::sanitize_title(&s())),
        "validateTitle" => Value::from(kinds(&model::validate_title(&s()))),
        "isValidTitle" => Value::from(model::is_valid_title(&s())),
        "isWindowsReservedName" => Value::from(model::is_windows_reserved_name(&s())),
        "validateFolderName" => Value::from(kinds(&model::validate_folder_name(&s()))),
        "isValidFolderName" => Value::from(model::is_valid_folder_name(&s())),
        "hasCaseInsensitiveSiblingCollision" => {
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let siblings = string_vec(input, "siblings");
            Value::from(model::has_case_insensitive_sibling_collision(name, &siblings))
        }
        "validateFolderPath" => Value::from(kinds(&model::validate_folder_path(&s()))),
        "isValidFolderPath" => Value::from(model::is_valid_folder_path(&s())),
        "pathDepth" => Value::from(model::path_depth(&s())),
        "tagRegexMatches" => Value::from(model::tags::tag_regex_matches(&s())),
        "isValidTagName" => Value::from(model::is_valid_tag_name(&s())),
        "normalizeTagName" => Value::from(model::normalize_tag_name(&s())),
        "extractTags" => Value::from(model::extract_tags(&s())),
        "extractHeaderTagBlock" => {
            let content = s();
            let block = model::extract_header_tag_block(&content);
            serde_json::json!({
                "tags": block.tags,
                "endOffset": block.end_offset,
                "remainder": &content[block.end_offset..],
            })
        }
        "makePreview" => Value::from(model::make_preview(&s())),
        "resolveWikilink" => {
            let target = input.get("target").and_then(|v| v.as_str()).unwrap_or_default();
            let all_ids = string_vec(input, "allIds");
            match model::resolve_wikilink(target, &all_ids) {
                Some(id) => Value::from(id),
                None => Value::Null,
            }
        }
        "shortestUniqueSuffix" => {
            let target_id = input.get("targetId").and_then(|v| v.as_str()).unwrap_or_default();
            let all_ids = string_vec(input, "allIds");
            Value::from(model::shortest_unique_suffix(target_id, &all_ids))
        }
        "rewriteWikilinks" => {
            let text = input.get("text").and_then(|v| v.as_str()).unwrap_or_default();
            let old_id = input.get("oldId").and_then(|v| v.as_str()).unwrap_or_default();
            let new_id = input.get("newId").and_then(|v| v.as_str()).unwrap_or_default();
            let all_ids = string_vec(input, "allIds");
            let (out, rewrites) = model::rewrite_wikilinks(text, old_id, new_id, &all_ids);
            serde_json::json!({ "text": out, "rewrites": rewrites })
        }
        "isImageFilename" => Value::from(model::is_image_filename(&s())),
        "imageExtensions" => Value::from(
            model::IMAGE_EXTENSIONS
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>(),
        ),
        other => panic!("no Rust dispatcher for conformance op {other:?}"),
    }
}
