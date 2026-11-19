//! JSON as this CLI prints it: pretty, compact, quoted, as a shell argument an agent can paste,
//! and a verb call as the agent would type it.

use super::*;

pub(crate) fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

pub(crate) fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// JSON as a shell argument the agent can paste. Single quotes need no escaping, unless the
/// JSON holds an apostrophe (`mom's list`): Claude Code's permission check refuses `'\''` and
/// `'"'"'` as brace expansion, and a `\u0027` the agent writes is decoded to `'` before the
/// shell sees it — only a double-quoted string gets through, measured 2026-10-05.
pub(crate) fn shell_json(value: &Value) -> String {
    let json = compact(value);
    if !json.contains('\'') {
        return format!("'{json}'");
    }
    let mut quoted = String::from("\"");
    for character in json.chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

/// One verb as the agent would type it after `just puppet`, quoted for the shell.
pub(crate) fn verb_call(verb: &str, args: &Value) -> String {
    format!("do {verb} {}", shell_json(args))
}

/// A batch as the agent would type it after `just puppet`, quoted for the shell: what every
/// refusal that names the way to a place prints.
pub(crate) fn batch_call(steps: &[Value]) -> String {
    format!("do {}", shell_json(&json!(steps)))
}

/// The editor's own typing for what a `type` or `press` was given: `do Type` takes any text
/// and a newline as Enter, `do Press` any one character too, on desktop and Android. The iOS
/// editor has no stand-in for typing (verb-map.md): there the way round is a direct edit.
pub(crate) fn editor_call_on(platform: NativePlatform, gesture: &str, args: &Value) -> String {
    if platform == NativePlatform::Ios {
        let text = if gesture == "type" {
            args.get("text").cloned().unwrap_or(json!("…"))
        } else {
            json!("…")
        };
        return format!(
            "a direct edit, which is not typing: {}",
            verb_call(
                "Insert",
                &json!({ "after": "<the text before it>", "text": text })
            )
        );
    }
    editor_call(gesture, args)
}

pub(crate) fn editor_call(gesture: &str, args: &Value) -> String {
    let (verb, keys): (&str, &[&str]) = if gesture == "type" {
        ("Type", &["text"])
    } else {
        ("Press", &["key", "count"])
    };
    let given: Map<String, Value> = keys
        .iter()
        .filter_map(|key| Some((key.to_string(), args.get(*key)?.clone())))
        .collect();
    verb_call(verb, &Value::Object(given))
}

pub(crate) fn quoted(value: &Value) -> String {
    match value {
        Value::String(text) => format!("{text:?}"),
        other => compact(other),
    }
}
