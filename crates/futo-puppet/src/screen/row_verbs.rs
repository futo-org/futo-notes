//! The verbs that act on one row, and the refusal when that row is not on screen, with the batch
//! that reaches it the way a person would.

use super::*;

/// Which apps have a verb: the desktop tree toggles a folder in place and has row menus, a
/// phone opens a folder as a screen of its own.
#[derive(PartialEq)]
pub(crate) enum Has {
    Both,
    Desktop,
    Phone,
}

/// The verbs that act on one row — the row a person clicks, taps, swipes or right-clicks —
/// the argument naming it, and which apps have them. A person can only do that to a row they
/// can see. A verb the app does not have is not checked: the app refuses it, with its own.
pub(crate) const ROW_VERBS: [(&str, &str, &str, Has); 10] = [
    ("OpenNote", "noteId", "note", Has::Both),
    ("OpenFolder", "path", "folder", Has::Phone),
    ("ToggleFolder", "path", "folder", Has::Desktop),
    ("OpenNoteContextMenu", "noteId", "note", Has::Both),
    ("OpenFolderContextMenu", "path", "folder", Has::Both),
    ("StartRenamingNote", "noteId", "note", Has::Desktop),
    ("StartRenamingFolder", "path", "folder", Has::Desktop),
    ("MoveNote", "noteId", "note", Has::Desktop),
    ("MoveFolder", "path", "folder", Has::Desktop),
    // A folder picker's row; no path is its Root row.
    ("PickFolder", "path", "folder", Has::Both),
];

/// A row verb's argument and row kind, if this app (`phone` or desktop) has it.
fn row_verb(verb: &str, phone: bool) -> Option<(&'static str, &'static str)> {
    let here = if phone { Has::Phone } else { Has::Desktop };
    ROW_VERBS
        .iter()
        .find(|(name, .., has)| *name == verb && (*has == Has::Both || *has == here))
        .map(|(_, key, kind, _)| (*key, *kind))
}

/// The row a verb needs: a [ROW_VERBS] verb's own row, or the row `ScrollToRow` scrolls to.
fn row_named(verb: &str, args: &Value, phone: bool) -> Option<(&'static str, String)> {
    if verb == "ScrollToRow" {
        return match (args["noteId"].as_str(), args["path"].as_str()) {
            (Some(id), None) => Some(("note", id.to_string())),
            (None, Some(path)) => Some(("folder", path.to_string())),
            _ => None,
        };
    }
    let (key, kind) = row_verb(verb, phone)?;
    let id = args[key]
        .as_str()
        .or((verb == "PickFolder").then_some(""))?;
    Some((kind, id.to_string()))
}

pub(crate) fn needs_row(verb: &str, phone: bool) -> bool {
    verb == "ScrollToRow" || row_verb(verb, phone).is_some()
}

/// Where a row is, against where the agent stands: the desktop tree's open folders, or a
/// phone's navigation stack (root first, its last entry the screen showing).
pub(crate) enum Place<'a> {
    Desktop { open: Vec<&'a str> },
    Phone { stack: Vec<&'a str> },
}

fn step(verb: &str, args: Value) -> Value {
    json!([verb, args])
}

/// The steps a person takes from here until `kind` `id`'s row is on screen, and where the row
/// is, in words. Every row step is scrolled to first unless its row is on screen now
/// (`on_screen`): after a toggle or a push nothing says where the next row lands. None when
/// the stack does not lead to the row's list.
pub(crate) fn reach(
    kind: &str,
    id: &str,
    place: &Place,
    on_screen: &dyn Fn(&str) -> bool,
) -> Option<(String, Vec<Value>)> {
    let key = if kind == "note" { "noteId" } else { "path" };
    let parent = id.rsplit_once('/').map_or("", |(parent, _)| parent);
    let chain = |below: &str| -> Vec<String> {
        let parts: Vec<&str> = parent.split('/').filter(|part| !part.is_empty()).collect();
        (1..=parts.len())
            .map(|depth| parts[..depth].join("/"))
            .filter(|folder| folder.len() > below.len())
            .collect()
    };
    let mut steps = Vec::new();
    let why = match place {
        Place::Desktop { open } => {
            let closed: Vec<String> = chain("")
                .into_iter()
                .filter(|folder| !open.contains(&folder.as_str()))
                .collect();
            for folder in &closed {
                if !(steps.is_empty() && on_screen(folder)) {
                    steps.push(step("ScrollToRow", json!({ "path": folder })));
                }
                steps.push(step("ToggleFolder", json!({ "path": folder })));
            }
            let names: Vec<String> = closed.iter().map(|folder| format!("`{folder}`")).collect();
            match names.len() {
                0 => "scrolled out of view".to_string(),
                1 => format!("inside the closed folder {}", names[0]),
                _ => format!("inside the closed folders {}", names.join(", ")),
            }
        }
        Place::Phone { stack } => {
            // An iOS search replaces the root list until its query is cleared.
            let leads_to = |depth: usize, entry: &str| {
                entry == "list"
                    || (depth == 0 && entry == "search")
                    || entry.strip_prefix("folder:").is_some_and(|folder| {
                        parent == folder || parent.starts_with(&format!("{folder}/"))
                    })
            };
            let from = (0..stack.len())
                .rev()
                .find(|depth| leads_to(*depth, stack[*depth]))?;
            let backs = stack.len() - 1 - from;
            steps.extend((0..backs).map(|_| step("GoBack", json!({}))));
            if stack[from] == "search" {
                steps.push(step("ClearSearchQuery", json!({})));
            }
            let below = stack[from].strip_prefix("folder:").unwrap_or("");
            for folder in chain(below) {
                if !(steps.is_empty() && on_screen(&folder)) {
                    steps.push(step("ScrollToRow", json!({ "path": folder })));
                }
                steps.push(step("OpenFolder", json!({ "path": folder })));
            }
            if steps.is_empty() {
                "in this list, off screen".to_string()
            } else if parent.is_empty() {
                "in the top-level list".to_string()
            } else {
                format!("in folder `{parent}`")
            }
        }
    };
    steps.push(step("ScrollToRow", json!({ key: id })));
    Some((why, steps))
}

/// Refuse a verb whose row is not on screen, with the batch that reaches the row and runs
/// it. `rows` is what the screen shows (a phone view's, or the desktop page's `elements`);
/// `screen` is the phone's screen, None on desktop; `app` the app as the step found it.
/// `ScrollToRow` passes when scrolling this list reaches its row. A note or folder the vault
/// does not have passes, so the app answers for it in its own words (and `DeleteFolder` of
/// one already gone is done).
pub(crate) fn row_refusal(
    app: &app::App,
    verb: &str,
    args: &Value,
    screen: Option<&str>,
    rows: &[Value],
) -> Option<Reply> {
    let (kind, id) = row_named(verb, args, screen.is_some())?;
    if native::row_for(rows, kind, &id).is_some() {
        return None;
    }
    let scrolls = verb == "ScrollToRow";
    let picks = verb == "PickFolder";
    let listed = if kind == "note" { "notes" } else { "folders" };
    let known = (picks && id.is_empty())
        || app.vault[listed]
            .as_array()
            .is_some_and(|all| all.iter().any(|entry| entry == id.as_str()));
    if !known {
        return None;
    }
    // A picker's rows are its own list: scrolling it is the one way to a row it has (a folder
    // it does not offer, the app refuses).
    if picks {
        return Some(Reply::refusal(
            409,
            format!(
                "`{}`'s row in the folder picker is not on screen: scroll the picker to it \
                 (`drag` on a phone, `scroll` on desktop), then pick it",
                if id.is_empty() { "Root" } else { id.as_str() }
            ),
        ));
    }
    let state = &app.state;
    let strings = |value: &Value| -> Option<Vec<String>> {
        value
            .as_array()?
            .iter()
            .map(|entry| entry.as_str().map(str::to_owned))
            .collect()
    };
    // The folders the desktop tree draws open, a drag hovering over one included.
    let known = match screen {
        None => strings(&state["openFolders"]),
        Some(screen) => strings(&state["stack"])
            .filter(|stack| stack.last().map(String::as_str) == Some(screen)),
    };
    let reached = known.as_ref().and_then(|known| {
        let known: Vec<&str> = known.iter().map(String::as_str).collect();
        let place = match screen {
            None => Place::Desktop { open: known },
            Some(_) => Place::Phone { stack: known },
        };
        reach(kind, &id, &place, &|folder| {
            native::row_for(rows, "folder", folder).is_some()
        })
    });
    let error = match reached {
        // Scrolling this list reaches it: ScrollToRow is the way.
        Some((_, steps)) if scrolls && steps.len() == 1 => return None,
        Some((why, mut steps)) => {
            if !scrolls {
                steps.push(step(verb, args.clone()));
            }
            let runs = if scrolls {
                String::new()
            } else {
                format!(" and runs {verb}")
            };
            format!(
                "`{id}` has no row here: it is {why}. This batch reaches it{runs}:\n{}",
                batch_call(&steps)
            )
        }
        None if scrolls => return None,
        None => format!(
            "`{id}` has no row on this screen ({}), and {verb} acts on its row: open its folder \
             and `ScrollToRow` to it first",
            screen.unwrap_or("desktop")
        ),
    };
    Some(Reply::refusal(409, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(batch: &[Value]) -> Vec<String> {
        batch.iter().map(compact).collect()
    }

    #[test]
    fn a_desktop_row_is_reached_by_opening_each_closed_folder_above_it_outermost_first() {
        let on_screen = |folder: &str| folder == "work";
        // `work/projects` stays open underneath a closed `work`, as the tree remembers it.
        let place = Place::Desktop {
            open: vec!["work/projects"],
        };
        let (why, batch) = reach("note", "work/projects/beacon/retro", &place, &on_screen).unwrap();
        assert_eq!(
            why,
            "inside the closed folders `work`, `work/projects/beacon`"
        );
        assert_eq!(
            steps(&batch),
            [
                r#"["ToggleFolder",{"path":"work"}]"#,
                r#"["ScrollToRow",{"path":"work/projects/beacon"}]"#,
                r#"["ToggleFolder",{"path":"work/projects/beacon"}]"#,
                r#"["ScrollToRow",{"noteId":"work/projects/beacon/retro"}]"#,
            ]
        );
        let open = Place::Desktop { open: vec!["work"] };
        let (why, batch) = reach("folder", "work/projects", &open, &|_| false).unwrap();
        assert_eq!(why, "scrolled out of view");
        assert_eq!(
            steps(&batch),
            [r#"["ScrollToRow",{"path":"work/projects"}]"#]
        );
    }

    #[test]
    fn a_phone_row_is_reached_back_down_the_stack_and_into_its_folder() {
        let none = |_: &str| false;
        // From another folder's note: back to the list, which every folder is under.
        let place = Place::Phone {
            stack: vec!["list", "folder:personal", "editor:personal/x"],
        };
        let (why, batch) = reach("note", "work/projects/overview", &place, &none).unwrap();
        assert_eq!(why, "in folder `work/projects`");
        assert_eq!(
            steps(&batch),
            [
                r#"["GoBack",{}]"#,
                r#"["GoBack",{}]"#,
                r#"["ScrollToRow",{"path":"work"}]"#,
                r#"["OpenFolder",{"path":"work"}]"#,
                r#"["ScrollToRow",{"path":"work/projects"}]"#,
                r#"["OpenFolder",{"path":"work/projects"}]"#,
                r#"["ScrollToRow",{"noteId":"work/projects/overview"}]"#,
            ]
        );
        // From a folder above it, down without going back; a folder row on screen is opened as is.
        let place = Place::Phone {
            stack: vec!["list", "folder:work"],
        };
        let (_, batch) = reach("note", "work/projects/overview", &place, &|f| {
            f == "work/projects"
        })
        .unwrap();
        assert_eq!(
            steps(&batch)[0],
            r#"["OpenFolder",{"path":"work/projects"}]"#
        );
        // In this list, below the fold.
        let (why, batch) = reach("folder", "work/a", &place, &none).unwrap();
        assert_eq!(why, "in this list, off screen");
        assert_eq!(steps(&batch), [r#"["ScrollToRow",{"path":"work/a"}]"#]);
        // A search over the iOS root is the list once its query is cleared.
        let searching = Place::Phone {
            stack: vec!["search", "folder:personal"],
        };
        let (_, batch) = reach("note", "work/a", &searching, &none).unwrap();
        assert_eq!(
            steps(&batch)[..2],
            [r#"["GoBack",{}]"#, r#"["ClearSearchQuery",{}]"#]
        );
    }

    #[test]
    fn a_batch_call_is_quoted_for_the_shell() {
        let batch = [json!(["OpenNote", {"noteId": "mom's list"}])];
        assert_eq!(
            batch_call(&batch),
            r#"do "[[\"OpenNote\",{\"noteId\":\"mom's list\"}]]""#
        );
    }
}
