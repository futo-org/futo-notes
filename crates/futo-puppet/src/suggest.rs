//! "Did you mean": the vault ids an app's missing one most likely meant.
//!
//! Every app refuses a note or folder it does not have in the same words — `no such note: <id>`,
//! `no such folder: <path>`, `not a pickable folder: <path>` — so the CLI adds the hint once, for
//! every verb on every platform. It names only ids the vault really has: the same id in another
//! case, or the same name in another folder. A typo is not guessed at.

use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Note,
    Folder,
}

const MISSING: [(&str, Kind); 3] = [
    ("no such note: ", Kind::Note),
    ("no such folder: ", Kind::Folder),
    ("not a pickable folder: ", Kind::Folder),
];

/// The argument a refusal says names nothing: its key, its value and what kind of id it is.
pub(crate) fn missing<'a>(args: &'a Value, error: &str) -> Option<(&'a str, &'a str, Kind)> {
    let given = args.as_object()?;
    MISSING.iter().find_map(|(prefix, kind)| {
        let rest = error.strip_prefix(prefix)?;
        given.iter().find_map(|(key, value)| {
            let value = value.as_str().filter(|value| !value.is_empty())?;
            let after = rest.strip_prefix(value)?;
            (after.is_empty() || after.starts_with(" (")).then_some((key.as_str(), value, *kind))
        })
    })
}

/// "did you mean …" for `key`'s `value`, from the ids the vault lists for its kind: the call with
/// the one id that fits, or the few that might. None when the vault has `value` itself (the app
/// refused it for another reason) or nothing close.
pub(crate) fn hint(
    verb: &str,
    args: &Value,
    key: &str,
    value: &str,
    ids: &[String],
) -> Option<String> {
    if ids.iter().any(|id| id == value) {
        return None;
    }
    match closest(value, ids).as_slice() {
        [] => None,
        [only] => {
            let mut fixed = args.clone();
            fixed[key] = Value::from(*only);
            Some(format!(
                "did you mean \"{only}\"? {}",
                crate::verb_call(verb, &fixed)
            ))
        }
        several => {
            let shown: Vec<String> = several
                .iter()
                .take(3)
                .map(|id| format!("\"{id}\""))
                .collect();
            let more = match several.len().saturating_sub(3) {
                0 => String::new(),
                more => format!(" (and {more} more)"),
            };
            let (last, rest) = shown.split_last()?;
            Some(format!("did you mean {} or {last}{more}?", rest.join(", ")))
        }
    }
}

/// The ids that are `wanted` in another case or, when none is, the ids of the same name in
/// another folder (the name being the last part of a path), in order.
fn closest<'a>(wanted: &str, ids: &'a [String]) -> Vec<&'a str> {
    let name = |id: &str| id.rsplit('/').next().unwrap_or(id).to_lowercase();
    let lower = wanted.to_lowercase();
    let mut matches: Vec<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| id.to_lowercase() == lower)
        .collect();
    if matches.is_empty() {
        let wanted_name = name(wanted);
        matches = ids
            .iter()
            .map(String::as_str)
            .filter(|id| name(id) == wanted_name)
            .collect();
    }
    matches.sort_unstable();
    matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(all: &[&str]) -> Vec<String> {
        all.iter().map(|id| id.to_string()).collect()
    }

    const VAULT: &[&str] = &[
        "work",
        "work/standup",
        "personal/standup",
        "journal",
        "journal/2025",
        "inbox/links to read",
        "budget",
    ];

    #[test]
    fn the_closest_ids_are_the_same_id_in_another_case_or_the_same_name_elsewhere() {
        let vault = ids(VAULT);
        assert_eq!(closest("Work", &vault), ["work"]);
        assert_eq!(
            closest("Inbox/Links To Read", &vault),
            ["inbox/links to read"]
        );
        // A name without its folder, or in the wrong one, is the ids of that name.
        assert_eq!(
            closest("standup", &vault),
            ["personal/standup", "work/standup"]
        );
        assert_eq!(
            closest("travel/Standup", &vault),
            ["personal/standup", "work/standup"]
        );
        assert_eq!(closest("2025", &vault), ["journal/2025"]);
    }

    #[test]
    fn anything_else_is_not_suggested() {
        let vault = ids(VAULT);
        // A typo is not guessed at, nor a part of a name.
        assert!(closest("wrk", &vault).is_empty());
        assert!(closest("jornal", &vault).is_empty());
        assert!(closest("links", &vault).is_empty());
        assert!(closest("groceries", &vault).is_empty());
        assert!(closest("anything", &[]).is_empty());
    }

    #[test]
    fn a_refusal_names_the_argument_it_could_not_find() {
        let args = json!({"noteId": "inbox/links to read", "targetPath": "Archive"});
        assert_eq!(
            missing(&args, "no such folder: Archive"),
            Some(("targetPath", "Archive", Kind::Folder))
        );
        let open = json!({"noteId": "standup"});
        assert_eq!(
            missing(
                &open,
                "no such note: standup (an id is the vault path without .md)"
            ),
            Some(("noteId", "standup", Kind::Note))
        );
        assert_eq!(
            missing(&json!({"path": "Work"}), "not a pickable folder: Work"),
            Some(("path", "Work", Kind::Folder))
        );
        // Another refusal, or an id that only starts the one it names, is not this one.
        assert_eq!(
            missing(&json!({"path": "work"}), "the note tree is not on screen"),
            None
        );
        assert_eq!(
            missing(&json!({"path": "work"}), "no such folder: work/team"),
            None
        );
    }

    #[test]
    fn the_hint_is_the_corrected_call_or_the_ids_that_might_be_meant() {
        let vault = ids(VAULT);
        let args = json!({"path": "Work"});
        assert_eq!(
            hint("OpenFolder", &args, "path", "Work", &vault).as_deref(),
            Some(r#"did you mean "work"? do OpenFolder '{"path":"work"}'"#)
        );
        let open = json!({"noteId": "standup"});
        assert_eq!(
            hint("OpenNote", &open, "noteId", "standup", &vault).as_deref(),
            Some(r#"did you mean "personal/standup" or "work/standup"?"#)
        );
        let many = ids(&["a/notes", "b/notes", "c/notes", "d/notes", "e/notes"]);
        assert_eq!(
            hint(
                "OpenNote",
                &json!({"noteId": "notes"}),
                "noteId",
                "notes",
                &many
            )
            .as_deref(),
            Some(r#"did you mean "a/notes", "b/notes" or "c/notes" (and 2 more)?"#)
        );
        // The vault has it: the app refused it for another reason, so there is nothing to mean.
        assert_eq!(hint("PickFolder", &args, "path", "work", &vault), None);
        assert_eq!(
            hint("OpenFolder", &json!({"path": "zzz"}), "path", "zzz", &vault),
            None
        );
    }
}
