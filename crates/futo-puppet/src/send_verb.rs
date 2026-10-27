//! Sending one verb: the CLI's own refusals first (refusals.rs), then the app's answer, and on a
//! phone the whole screen before and after it.

use super::*;

/// This screen's verbs as `actions` lists them, JSON Schema each, read once a step; Null when
/// the app cannot say yet, which it is not waited for: the verb's own call waits on a not-ready
/// app.
pub(crate) fn menu(target: &Target) -> Result<Value, String> {
    let reply = call_once(target, "actions", &json!({}))?;
    Ok(if reply.status == 200 {
        reply.body
    } else {
        Value::Null
    })
}

/// Send one verb, unless the CLI refuses it first: an argument it does not take, or a row it
/// needs that is not on screen. A verb this screen does not have, the app refuses, and the
/// refusal then lists the ones it has, which is what the agent would read `actions` for next.
/// `app` is the app as the step found it, `view` a phone's screen (None on desktop).
pub(crate) fn send_verb(
    target: &Target,
    menu: &Value,
    app: &app::App,
    verb: &str,
    args: &Value,
    view: Option<&screen::View>,
) -> Result<Reply, String> {
    if let Some(mut error) = argument_error(menu, verb, args) {
        // A row's menu acts on the row it is open for, so its verbs take no row: say which.
        let names_a_row = ["noteId", "path"]
            .iter()
            .any(|key| args.get(key).is_some() && !verb_takes(menu, verb, key));
        if names_a_row {
            if let Some(row) = open_menu_row(&screen_rows(target, view)?) {
                error.push_str(&format!(
                    "; {verb} acts on {row}, the row this menu is open for"
                ));
            }
        }
        return Ok(Reply::refusal(400, error));
    }
    let names: Vec<&str> = menu["actions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|action| action["name"].as_str())
        .collect();
    // A verb this screen does not offer (a dialog covers its row) is the app's to refuse: a
    // row hint would send the agent scrolling behind the dialog.
    let offered = names.is_empty() || names.contains(&verb);
    if offered {
        if let Some(refusal) = row_check(target, app, verb, args, view)? {
            return Ok(refusal);
        }
    }
    let mut reply = call(target, "do", &json!({ "verb": verb, "args": args }))?;
    if reply.status == 202 {
        reply = await_pending(target, reply)?;
    }
    if reply.status == 404 && !names.is_empty() && !names.contains(&verb) {
        if let Some(error) = reply.body["error"].as_str() {
            let screen = menu["screen"].as_str().unwrap_or("this screen");
            reply.body["error"] = json!(format!("{error}\n{screen} has: {}", names.join(", ")));
        }
    }
    if reply.status == 400 {
        if let Some(hint) = reply.body["error"]
            .as_str()
            .and_then(|error| vault_hint(&app.vault, verb, args, error))
        {
            let error = reply.body["error"].as_str().unwrap_or_default();
            reply.body["error"] = json!(format!("{error}; {hint}"));
        }
    }
    Ok(reply)
}

/// A verb's reply, and on a phone the screen before and after it (the same screen twice when
/// it was refused), which a batch diffs end to end.
type Ran = (Reply, Option<(screen::View, screen::View)>);

/// One verb through [send_verb]. On a phone the receipt is the whole screen before and after
/// (with the editor up, the page's own receipt keeps its document, selection and events, and
/// takes the screen's element diff); on desktop the page's receipt already is.
pub(crate) fn run_verb(
    target: &Target,
    menu: &Value,
    verb: &str,
    args: &Value,
) -> Result<Ran, String> {
    let Target::Native(..) = target else {
        let app_before = app::read(target)?;
        let mut reply = send_verb(target, menu, &app_before, verb, args, None)?;
        if reply.status < 400 {
            app::record(&mut reply.body, &app_before, &app::read(target)?);
        }
        return Ok((reply, None));
    };
    let before = screen::view(target)?;
    // A page verb speaks CSS pixels; the agent spoke screen units.
    let mut args = args.clone();
    if let Some((dx, dy)) = before.page_offset() {
        screen::shift(&mut args, (-dx, -dy));
    }
    let app_before = app::read(target)?;
    let mut reply = send_verb(target, menu, &app_before, verb, &args, Some(&before))?;
    if reply.status >= 400 {
        return Ok((reply, Some((before.clone(), before))));
    }
    let after = screen::settle(target, &before, before.webview.is_some())?;
    if reply.body["diff"].is_object() {
        if let Some(offset) = before.page_offset() {
            screen::shift(&mut reply.body["diff"], offset);
        }
        screen::merge_change(&mut reply.body, &before, &after);
    } else if let Some(receipt) = reply.body.as_object_mut() {
        receipt.insert("diff".into(), screen::change(&before, &after));
    }
    app::record(&mut reply.body, &app_before, &app::read(target)?);
    Ok((reply, Some((before, after))))
}
