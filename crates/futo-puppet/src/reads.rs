//! Reads: one query, which on a phone answers `elements` and `show` from the whole screen, and
//! `look`, every read at once.

use super::*;

/// A read. On a phone `elements` and `show` answer from the whole screen, and the page's
/// reads, which exist only while the editor is up, speak the screen's units there.
pub(crate) fn query(target: &Target, command: &str, args: &Value) -> Result<Reply, String> {
    const PAGE_ONLY: [&str; 5] = ["doc", "at", "events", "diff", "show"];
    if command == "file" {
        return file(target, args);
    }
    let Target::Native(..) = target else {
        return call(target, command, args);
    };
    if command != "elements" && !PAGE_ONLY.contains(&command) {
        return call(target, command, args);
    }
    let view = screen::view(target)?;
    if command == "elements" {
        return Ok(Reply {
            status: 200,
            body: view.body(),
        });
    }
    let reference = args["ref"].as_str();
    // `show {"text"}` is the page's: where text shows in the editor.
    if command == "show"
        && args["text"].is_null()
        && !reference.is_some_and(|reference| reference.starts_with('e'))
    {
        return Ok(
            match view
                .rows
                .iter()
                .find(|row| row["ref"].as_str() == reference)
            {
                Some(row) => Reply {
                    status: 200,
                    body: row.clone(),
                },
                None => Reply::refusal(
                    404,
                    format!(
                        "{} is not on this screen ({}); `elements` lists what is",
                        reference.unwrap_or("that ref"),
                        view.screen
                    ),
                ),
            },
        );
    }
    let Some(offset) = view.page_offset() else {
        return Ok(Reply::refusal(
            409,
            format!(
                "{command} reads the editor's page, and this screen ({}) is native: `elements` \
                 lists what is on it, `state` says where you are",
                view.screen
            ),
        ));
    };
    let mut args = args.clone();
    screen::shift(&mut args, (-offset.0, -offset.1));
    let mut reply = call(target, command, &args)?;
    screen::shift(&mut reply.body, offset);
    Ok(reply)
}

/// `look`: the whole screen in one read, from the queries and renderers `state`, `elements`,
/// `actions`, `notes` and `doc` use, for the start of a session, after `relaunch`, or when
/// lost. After an action its receipt says what changed; this is everything there is.
pub(crate) fn look(target: &Target) -> Result<String, String> {
    let read = |command: &str| -> Result<Value, String> {
        let reply = query(target, command, &json!({}))?;
        if reply.status == 200 {
            Ok(reply.body)
        } else {
            Err(format!("{command}: {}", compact(&reply.body)))
        }
    };
    let mut state = read("state")?;
    let editing = state["screen"]
        .as_str()
        .is_some_and(|screen| screen.starts_with("editor:"));
    // Every stored setting is `state`'s to show, and with no note open so is the editor's
    // selection and history; here they would be most of the read.
    if let Some(fields) = state.as_object_mut() {
        fields.remove("settings");
        if !editing {
            fields.remove("editor");
        }
    }
    let elements = read("elements")?;
    let mut out = render_query("state", &state);
    out.push_str(&render_query("elements", &elements));
    out.push_str(&look_verbs(&elements, &read("actions")?));
    match read("notes") {
        Ok(body) => out.push_str(render_notes(&body).lines().next().unwrap_or_default()),
        Err(error) => out.push_str(&error),
    }
    out.push('\n');
    if editing {
        match read("doc") {
            Ok(body) => out.push_str(&render_query("doc", &body)),
            Err(error) => out.push_str(&format!("{error}\n")),
        }
    }
    Ok(out)
}

/// The screen's verbs for `look`. A row already names the verb that does what touching it
/// does (`→ Verb`), so those are one line with what they take; the rest, and any with a
/// shortcut, as `actions` lists them.
pub(crate) fn look_verbs(elements: &Value, actions: &Value) -> String {
    let on_rows: Vec<&str> = elements["elements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["verb"].as_str())
        .collect();
    let (on_a_row, others): (Vec<Value>, Vec<Value>) = actions["actions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        // A shortcut needs its line saying what it stands for, so its verb stays listed.
        .partition(|action| {
            action["shortcuts"].as_object().is_none_or(Map::is_empty)
                && action["name"]
                    .as_str()
                    .is_some_and(|name| on_rows.contains(&name))
        });
    let mut others_body = actions.clone();
    others_body["actions"] = Value::Array(others);
    // `actions` opens with the screen's name, which `state` just gave.
    let listed = render_actions(&others_body);
    let mut out = format!(
        "verbs no row shows:\n{}",
        listed.split_once('\n').map_or("", |(_, rest)| rest)
    );
    if !on_a_row.is_empty() {
        let named: Vec<String> = on_a_row
            .iter()
            .map(|action| {
                format!(
                    "{} {}",
                    action["name"].as_str().unwrap_or("?"),
                    parameters(&action["schema"])
                )
                .trim_end()
                .to_string()
            })
            .collect();
        out.push_str(&format!("verbs on rows: {}\n", named.join(" · ")));
    }
    out
}
