//! What an action did beyond the rows on screen: the app's `state` (settings, sync, the open
//! note and its panels, what the app last copied) and its vault (the notes and folders, and
//! which notes it wrote). Read before and after every action on every target and diffed
//! here, once, so a receipt says what happened wherever it happened: a Settings switch that
//! repaints nothing an agent would look at, a copied path, a rename that rewrote the notes
//! linking to it.

use super::*;

/// `state` keys a receipt already reports elsewhere: the screen (and the iOS sheet, which is
/// part of its name, and the phones' navigation stack under it) is the diff's `screen`, the
/// document and selection are its `doc` and `selection`.
const REPORTED_ELSEWHERE: [&str; 5] = [
    "screen",
    "sheet",
    "stack",
    "editor.docVersion",
    "editor.selection",
];

/// Values that change as one: a copy is its text and its count together, so copying the same
/// path twice still reads as a copy; an opened page likewise; which lines show, as one range.
const WHOLE: [&str; 3] = ["copied", "opened", "editor.onScreen"];

pub(crate) struct App {
    pub(crate) state: Value,
    pub(crate) vault: Value,
}

/// The app as the action leaves it. Read once each, without the not-ready retry: a part the
/// app cannot report yet (Android's first-run screen has no vault) is left out of the diff
/// instead of holding up the action. An app that does not answer ends the command.
pub(crate) fn read(target: &Target) -> Result<App, String> {
    let part = |command: &str, args: Value| -> Result<Value, String> {
        let reply = call_once(target, command, &args)?;
        Ok(if reply.status == 200 {
            reply.body
        } else {
            Value::Null
        })
    };
    Ok(App {
        state: part("state", json!({}))?,
        vault: part("notes", json!({ "modified": true }))?,
    })
}

/// Whether [record] found anything the action did to the app's state or vault.
pub(crate) fn changed(receipt: &Value) -> bool {
    receipt["diff"].get("state").is_some() || receipt["diff"].get("vault").is_some()
}

/// Add what changed between `before` and `after` to the receipt's `diff`.
pub(crate) fn record(receipt: &mut Value, before: &App, after: &App) {
    let mut state = Map::new();
    changes("", &before.state, &after.state, &mut state);
    let vault = vault_change(before, after);
    if state.is_empty() && vault.is_empty() {
        return;
    }
    let Some(diff) = receipt_diff(receipt) else {
        return;
    };
    if !state.is_empty() {
        diff.insert("state".into(), Value::Object(state));
    }
    if !vault.is_empty() {
        diff.insert("vault".into(), Value::Object(vault));
    }
}

/// The receipt's `diff`, made an object when it is missing or not one.
pub(crate) fn receipt_diff(receipt: &mut Value) -> Option<&mut Map<String, Value>> {
    let diff = receipt
        .as_object_mut()?
        .entry("diff")
        .or_insert_with(|| json!({}));
    if !diff.is_object() {
        *diff = json!({});
    }
    diff.as_object_mut()
}

/// Every path whose value differs, as `[before, after]`; a key present on one side only is
/// `null` on the other, and an object that appeared or went is one entry, not its leaves.
fn changes(path: &str, before: &Value, after: &Value, into: &mut Map<String, Value>) {
    if before == after || REPORTED_ELSEWHERE.contains(&path) {
        return;
    }
    match (before, after) {
        (Value::Object(was), Value::Object(now)) if !WHOLE.contains(&path) => {
            let keys: std::collections::BTreeSet<&String> = was.keys().chain(now.keys()).collect();
            for key in keys {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                changes(
                    &child,
                    was.get(key).unwrap_or(&Value::Null),
                    now.get(key).unwrap_or(&Value::Null),
                    into,
                );
            }
        }
        // A large object that went is said by its going: its old contents (a whole editor's
        // state) would only repeat the screen before. A small one names what went.
        _ if before.is_object() && after.is_null() && compact(before).chars().count() > 80 => {
            into.insert(path.to_string(), json!(["{…}", null]));
        }
        _ => {
            into.insert(path.to_string(), json!([before, after]));
        }
    }
}

/// Notes and folders added and removed, and the notes written in place. The open note is
/// left out of `written`: its text is the diff's `doc`, and it saves on its own schedule,
/// which would pin the save on whatever action came next.
fn vault_change(before: &App, after: &App) -> Map<String, Value> {
    let mut out = Map::new();
    if before.vault.is_null() || after.vault.is_null() {
        return out;
    }
    let set = |vault: &Value, key: &str| -> std::collections::BTreeSet<String> {
        vault[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect()
    };
    let open: Vec<&str> = [&before.state, &after.state]
        .iter()
        .filter_map(|state| state["screen"].as_str()?.strip_prefix("editor:"))
        .collect();
    for key in ["notes", "folders"] {
        let (was, now) = (set(&before.vault, key), set(&after.vault, key));
        let mut group = Map::new();
        let added: Vec<&String> = now.difference(&was).collect();
        let removed: Vec<&String> = was.difference(&now).collect();
        if !added.is_empty() {
            group.insert("added".into(), json!(added));
        }
        if !removed.is_empty() {
            group.insert("removed".into(), json!(removed));
        }
        if key == "notes" {
            let written: Vec<&String> = was
                .intersection(&now)
                .filter(|id| !open.contains(&id.as_str()))
                .filter(|id| before.vault["modified"][id] != after.vault["modified"][id])
                .collect();
            if !written.is_empty() {
                group.insert("written".into(), json!(written));
            }
        }
        if !group.is_empty() {
            out.insert(key.into(), Value::Object(group));
        }
    }
    out
}

/// The `state` and `vault` lines of a receipt.
pub(crate) fn render(diff: &Value) -> String {
    let mut out = String::new();
    for (path, pair) in diff["state"].as_object().into_iter().flatten() {
        if path == "copied" {
            // In full, or nearly: a copied path is what the agent will paste somewhere.
            out.push_str(&format!("copied {}\n", compact(&pair[1]["text"])));
        } else if path == "opened" {
            // Which page a button handed to the browser, which the app's own rows cannot say.
            out.push_str(&format!("opened {}\n", compact(&pair[1]["url"])));
        } else if let Some(members) = list_change(&pair[0], &pair[1]) {
            out.push_str(&format!("{path} {members}\n"));
        } else {
            out.push_str(&format!(
                "{path} {} → {}\n",
                compact(&pair[0]),
                compact(&pair[1])
            ));
        }
    }
    let mut vault = Vec::new();
    for (key, noun) in [("notes", "note"), ("folders", "folder")] {
        for (change, sign) in [("added", "+"), ("removed", "-"), ("written", "wrote ")] {
            for id in diff["vault"][key][change].as_array().into_iter().flatten() {
                vault.push(format!("{sign}{noun} {}", quoted(id)));
            }
        }
    }
    if !vault.is_empty() {
        out.push_str(&format!("vault {}\n", vault.join("  ")));
    }
    out
}

/// A list that gained or lost members, as those members (`+"ideas" -"inbox"`): its whole
/// before and after would bury them past the end of the line. `None` for a list that only
/// moved its members, which reads as before → after.
fn list_change(before: &Value, after: &Value) -> Option<String> {
    let (was, now) = (before.as_array()?, after.as_array()?);
    let mut members: Vec<String> = now
        .iter()
        .filter(|member| !was.contains(member))
        .map(|member| format!("+{}", compact(member)))
        .collect();
    members.extend(
        was.iter()
            .filter(|member| !now.contains(member))
            .map(|member| format!("-{}", compact(member))),
    );
    (!members.is_empty()).then(|| members.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(state: Value, vault: Value) -> App {
        App { state, vault }
    }

    fn diff_of(before: &App, after: &App) -> Value {
        let mut receipt = json!({});
        record(&mut receipt, before, after);
        receipt["diff"].clone()
    }

    #[test]
    fn a_setting_that_changed_is_one_line_and_what_the_diff_already_says_is_not() {
        let vault = json!({"notes": [], "folders": []});
        let before = app(
            json!({"screen": "settings", "settings": {"theme": "auto", "issueReporting": {"enabled": true}},
                   "editor": {"docVersion": 3, "selection": {"from": 1}, "find": {"open": false}}}),
            vault.clone(),
        );
        let after = app(
            json!({"screen": "list", "settings": {"theme": "dark", "issueReporting": {"enabled": true}},
                   "editor": {"docVersion": 9, "selection": {"from": 4}, "find": {"open": true}}}),
            vault,
        );
        let diff = diff_of(&before, &after);
        assert_eq!(
            diff["state"],
            json!({"editor.find.open": [false, true], "settings.theme": ["auto", "dark"]})
        );
        assert_eq!(
            render(&diff),
            "editor.find.open false → true\nsettings.theme \"auto\" → \"dark\"\n"
        );
    }

    #[test]
    fn an_object_that_appeared_or_went_is_one_entry() {
        let vault = json!({"notes": [], "folders": []});
        let diff = diff_of(
            &app(json!({"screen": "list"}), vault.clone()),
            &app(
                json!({"screen": "search", "search": {"query": "", "hits": []}}),
                vault,
            ),
        );
        assert_eq!(
            diff["state"],
            json!({"search": [null, {"query": "", "hits": []}]})
        );
        let went = diff_of(
            &app(
                json!({"editor": {"ready": true, "docHead": "the quick brown fox", "size": 1234,
                                  "find": {"open": false, "query": ""}},
                       "note": {"id": "scratch"}}),
                Value::Null,
            ),
            &app(json!({}), Value::Null),
        );
        assert_eq!(
            went["state"],
            json!({"editor": ["{…}", null], "note": [{"id": "scratch"}, null]})
        );
    }

    #[test]
    fn a_list_that_changed_members_names_them_and_one_that_only_moved_shows_both() {
        let vault = json!({"notes": [], "folders": []});
        let long = |extra: &[&str]| {
            let mut folders: Vec<String> =
                (0..9).map(|n| format!("some/long/folder {n}")).collect();
            folders.extend(extra.iter().map(|folder| folder.to_string()));
            json!({"settings": {"openFolders": folders}, "tabs": ["a", "b"]})
        };
        let mut after = long(&["ideas"]);
        after["tabs"] = json!(["b", "a"]);
        let diff = diff_of(&app(long(&["inbox"]), vault.clone()), &app(after, vault));
        assert_eq!(
            render(&diff),
            "settings.openFolders +\"ideas\" -\"inbox\"\ntabs [\"a\",\"b\"] → [\"b\",\"a\"]\n"
        );
    }

    #[test]
    fn a_copy_names_its_text_even_when_it_is_the_same_text_again() {
        let vault = json!({"notes": [], "folders": []});
        let diff = diff_of(
            &app(
                json!({"copied": {"count": 1, "text": "/v/a.md"}}),
                vault.clone(),
            ),
            &app(json!({"copied": {"count": 2, "text": "/v/a.md"}}), vault),
        );
        assert_eq!(render(&diff), "copied \"/v/a.md\"\n");
    }

    #[test]
    fn an_opened_page_names_its_url_even_when_it_is_the_same_page_again() {
        let vault = json!({"notes": [], "folders": []});
        let diff = diff_of(
            &app(
                json!({"opened": {"count": 1, "url": "https://futo.org/buy"}}),
                vault.clone(),
            ),
            &app(
                json!({"opened": {"count": 2, "url": "https://futo.org/buy"}}),
                vault,
            ),
        );
        assert_eq!(render(&diff), "opened \"https://futo.org/buy\"\n");
    }

    #[test]
    fn the_vault_says_what_came_went_and_was_written_except_the_open_note() {
        let before = app(
            json!({"screen": "editor:index"}),
            json!({"notes": ["index", "work/a", "work/b"], "folders": ["work"],
                   "modified": {"index": 1, "work/a": 1, "work/b": 1}}),
        );
        let after = app(
            json!({"screen": "editor:index"}),
            json!({"notes": ["index", "archive/a", "work/b"], "folders": ["archive", "work"],
                   "modified": {"index": 2, "archive/a": 2, "work/b": 2}}),
        );
        let diff = diff_of(&before, &after);
        assert_eq!(
            diff["vault"],
            json!({"notes": {"added": ["archive/a"], "removed": ["work/a"], "written": ["work/b"]},
                   "folders": {"added": ["archive"]}})
        );
        assert_eq!(
            render(&diff),
            "vault +note \"archive/a\"  -note \"work/a\"  wrote note \"work/b\"  +folder \"archive\"\n"
        );
    }

    #[test]
    fn a_part_the_app_could_not_report_is_left_out_and_nothing_changed_adds_no_diff() {
        let same = json!({"screen": "onboarding"});
        let diff = diff_of(
            &app(same.clone(), Value::Null),
            &app(same, json!({"notes": ["a"], "folders": []})),
        );
        assert!(diff.is_null());
    }
}
