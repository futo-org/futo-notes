//! What the CLI refuses before it sends a verb, and what it adds to the app's refusal: an
//! argument the verb does not take, a row that is not on screen, the vault ids close to one it
//! does not have (suggest.rs).

use super::*;

/// What is wrong with `args` for `verb`, judged by its schema in this screen's `actions` (the
/// phones' own verbs ignore a key they do not read, so a misnamed one did nothing, silently).
/// None when they fit, or the menu does not list the verb. A lone misnamed argument that one
/// unused parameter would take is named with the call it meant.
pub(crate) fn argument_error(menu: &Value, verb: &str, args: &Value) -> Option<String> {
    let schema = &menu["actions"]
        .as_array()?
        .iter()
        .find(|action| action["name"] == verb)?["schema"];
    let given = args.as_object()?;
    let none = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&none);
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|keys| keys.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    // A type this check does not know is the app's to judge.
    let fits = |key: &str, value: &Value| {
        let wanted = properties[key]["type"].as_str().unwrap_or("");
        let known = ["string", "boolean", "number", "integer", "array", "object"];
        if !known.contains(&wanted) {
            return true;
        }
        let allowed = properties[key]["enum"].as_array();
        match value {
            Value::String(_) => {
                wanted == "string" && allowed.is_none_or(|allowed| allowed.contains(value))
            }
            Value::Bool(_) => wanted == "boolean",
            Value::Number(number) => {
                wanted == "number" || (wanted == "integer" && (number.is_i64() || number.is_u64()))
            }
            Value::Array(_) => wanted == "array",
            Value::Object(_) => wanted == "object",
            Value::Null => false,
        }
    };
    let takes = match parameters(schema) {
        accepted if accepted.is_empty() => "takes no arguments".to_string(),
        accepted => format!("takes {accepted}"),
    };
    let unknown: Vec<&String> = given
        .keys()
        .filter(|key| !properties.contains_key(*key))
        .collect();
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|key| !given.contains_key(*key))
        .collect();
    if let [wrong] = unknown.as_slice() {
        let unused: Vec<&str> = if missing.is_empty() {
            properties
                .keys()
                .map(String::as_str)
                .filter(|key| !given.contains_key(*key))
                .collect()
        } else {
            missing.clone()
        };
        let meant: Vec<&str> = unused
            .into_iter()
            .filter(|key| fits(key, &given[*wrong]))
            .collect();
        if let [meant] = meant.as_slice() {
            let mut fixed = given.clone();
            let value = fixed.remove(*wrong).unwrap_or_default();
            fixed.insert(meant.to_string(), value);
            return Some(format!(
                "unknown argument \"{wrong}\"; did you mean \"{meant}\"? {}",
                verb_call(verb, &Value::Object(fixed))
            ));
        }
    }
    if let Some(wrong) = unknown.first() {
        return Some(format!("unknown argument \"{wrong}\" — {takes}"));
    }
    if let Some(key) = missing.first() {
        return Some(format!("missing required argument \"{key}\" — {takes}"));
    }
    let (key, value) = given.iter().find(|(key, value)| !fits(key, value))?;
    if let (Value::String(_), Some(allowed)) = (value, properties[key]["enum"].as_array()) {
        let allowed: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
        return Some(format!(
            "argument \"{key}\" must be one of {}, not {value}",
            allowed.join(", ")
        ));
    }
    Some(format!(
        "argument \"{key}\" must be {} — {takes}",
        properties[key]["type"].as_str().unwrap_or("?")
    ))
}

/// Whether `verb`'s schema in this screen's `menu` takes `key`.
pub(crate) fn verb_takes(menu: &Value, verb: &str, key: &str) -> bool {
    menu["actions"].as_array().is_some_and(|actions| {
        actions.iter().any(|action| {
            action["name"] == verb && action["schema"]["properties"].get(key).is_some()
        })
    })
}

/// The screen's rows: a phone's whole screen, already read (`view`), or the desktop page's
/// `elements`.
pub(crate) fn screen_rows(
    target: &Target,
    view: Option<&screen::View>,
) -> Result<Vec<Value>, String> {
    Ok(match view {
        Some(view) => view.rows.clone(),
        None => call(target, "elements", &json!({}))?.body["elements"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    })
}

/// The row an open row menu acts on, from its section (`menu · note "Welcome"`).
pub(crate) fn open_menu_row(rows: &[Value]) -> Option<String> {
    rows.iter().find_map(|row| {
        row["section"]
            .as_str()?
            .strip_prefix("menu · ")
            .map(str::to_string)
    })
}

/// The row check before a verb that needs one row on screen, against what the screen shows
/// (read only for such a verb on desktop) and the app as the step found it.
pub(crate) fn row_check(
    target: &Target,
    app: &app::App,
    verb: &str,
    args: &Value,
    view: Option<&screen::View>,
) -> Result<Option<Reply>, String> {
    if !screen::needs_row(verb, matches!(target, Target::Native(..))) {
        return Ok(None);
    }
    let rows = screen_rows(target, view)?;
    Ok(screen::row_refusal(
        app,
        verb,
        args,
        view.map(|view| view.screen.as_str()),
        &rows,
    ))
}

/// For a refusal naming a note or folder the vault does not have, the ids it has that are close
/// (suggest.rs), from the vault as the step found it.
pub(crate) fn vault_hint(vault: &Value, verb: &str, args: &Value, error: &str) -> Option<String> {
    let (key, value, kind) = suggest::missing(args, error)?;
    let listed = match kind {
        suggest::Kind::Note => "notes",
        suggest::Kind::Folder => "folders",
    };
    let ids: Vec<String> = vault[listed]
        .as_array()?
        .iter()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect();
    suggest::hint(verb, args, key, value, &ids)
}
