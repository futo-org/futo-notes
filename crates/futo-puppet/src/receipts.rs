//! What an action did, as text: a `do` step's receipt, a gesture's action record and its page events.

use super::*;

fn is_move(event: &Value) -> bool {
    event["type"].as_str().is_some_and(|t| t.ends_with("move"))
}

/// One event per line; a run of move events (pointermove/touchmove interleave) collapses to `×N`.
/// With `key_runs`, as in a receipt, each key press is one line instead of its keydown through
/// keyup, and presses that went the same way share it: `keys "lease" ×5`. `events` keeps them all.
pub(crate) fn render_events(events: &[Value], key_runs: bool) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index < events.len() {
        if key_runs {
            if let Some(press) = key_press_len(&events[index..]) {
                let shape = key_press_shape(&events[index..index + press]);
                let mut presses = vec![&events[index..index + press]];
                index += press;
                while let Some(next) = key_press_len(&events[index..]) {
                    if key_press_shape(&events[index..index + next]) != shape {
                        break;
                    }
                    presses.push(&events[index..index + next]);
                    index += next;
                }
                out.push_str(&render_key_run(&presses));
                continue;
            }
        }
        let event = &events[index];
        let mut run = 1;
        let mut kinds = vec![event["type"].as_str().unwrap_or("?")];
        if is_move(event) {
            while index + run < events.len() && is_move(&events[index + run]) {
                let kind = events[index + run]["type"].as_str().unwrap_or("?");
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
                run += 1;
            }
        }
        let last = &events[index + run - 1];
        let mut line = format!(
            "#{:<4} {:>6}ms  {}",
            event["id"].to_string(),
            event["t"].to_string(),
            kinds.join("/")
        );
        if run > 1 {
            line.push_str(&format!(" ×{run}"));
        }
        if let (Some(x), Some(y)) = (last["x"].as_f64(), last["y"].as_f64()) {
            line.push_str(&format!("  @{x},{y}"));
        }
        if let Some(key) = event["key"].as_str() {
            line.push_str(&format!("  key={key:?}"));
        }
        if let Some(data) = event["data"].as_str() {
            line.push_str(&format!("  data={data:?}"));
        }
        line.push_str(&target_and_handlers(event, &handler_texts(event)));
        if let Some(editor) = event["editor"].as_object() {
            line.push_str(&format!(
                "  editor: resolved {} settled {}",
                editor.get("resolved").map(compact).unwrap_or_default(),
                editor
                    .get("settled")
                    .map(selection_text)
                    .unwrap_or_default()
            ));
        }
        if let Some(selection) = event.get("selection") {
            line.push_str(&format!("  selection {}", selection_text(selection)));
        }
        out.push_str(&line);
        out.push('\n');
        index += run;
    }
    out
}

/// How many events one key press took: a keydown through the keyup of the same key, with no
/// other keydown between (a chord's keys print one by one).
fn key_press_len(events: &[Value]) -> Option<usize> {
    let keydown = events.first().filter(|event| event["type"] == "keydown")?;
    for (offset, event) in events.iter().enumerate().skip(1) {
        match event["type"].as_str() {
            Some("keydown") => return None,
            Some("keyup") if event["key"] == keydown["key"] => return Some(offset + 1),
            _ => {}
        }
    }
    None
}

/// What two presses share to print as one line: each event, where it went, every handler that
/// ran and what it did. A press a handler prevented is shaped apart, so it gets its own line.
fn key_press_shape(press: &[Value]) -> Vec<String> {
    press
        .iter()
        .map(|event| {
            format!(
                "{} {}{}",
                event["type"].as_str().unwrap_or("?"),
                target_and_handlers(event, &handler_texts(event)),
                event["modifiers"].as_str().unwrap_or("")
            )
        })
        .collect()
}

/// Presses that went the same way: their keys, the events each took, where, every handler.
fn render_key_run(presses: &[&[Value]]) -> String {
    let first = &presses[0][0];
    let keys: Vec<&str> = presses
        .iter()
        .map(|press| press[0]["key"].as_str().unwrap_or("?"))
        .collect();
    let keys = if keys.iter().all(|key| key.chars().count() == 1) {
        format!("{:?}", keys.concat())
    } else if keys.iter().all(|key| *key == keys[0]) {
        format!("{:?}", keys[0])
    } else {
        keys.iter()
            .map(|key| format!("{key:?}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut kinds: Vec<&str> = Vec::new();
    let mut handlers: Vec<String> = Vec::new();
    for event in presses[0].iter() {
        let kind = event["type"].as_str().unwrap_or("?");
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
        for handler in handler_texts(event) {
            if !handlers.contains(&handler) {
                handlers.push(handler);
            }
        }
    }
    let mut line = format!(
        "#{:<4} {:>6}ms  keys {keys}",
        first["id"].to_string(),
        first["t"].to_string()
    );
    if presses.len() > 1 {
        line.push_str(&format!(" ×{}", presses.len()));
    }
    line.push_str(&format!(": {}", kinds.join("/")));
    line.push_str(&target_and_handlers(first, &handlers));
    let selection = presses
        .iter()
        .rev()
        .flat_map(|press| press.iter().rev())
        .find_map(|event| event.get("selection"));
    if let Some(selection) = selection {
        line.push_str(&format!("  selection {}", selection_text(selection)));
    }
    line.push('\n');
    line
}

/// `  meta  synthetic  → e9 Component.svelte  handlers: fn@on!prevent …`
fn target_and_handlers(event: &Value, handlers: &[String]) -> String {
    let mut text = String::new();
    if let Some(modifiers) = event["modifiers"].as_str() {
        text.push_str(&format!("  {modifiers}"));
    }
    if event["trusted"] == false {
        text.push_str("  synthetic");
    }
    text.push_str(&format!(
        "  → {} {}",
        event["target"].as_str().unwrap_or("?"),
        event["component"].as_str().unwrap_or("-")
    ));
    if !handlers.is_empty() {
        text.push_str(&format!("  handlers: {}", handlers.join(" ")));
    }
    text
}

/// Each handler that ran, `fn@on`, marked with what it did: `!prevent`, `!stop`, `!threw(…)`.
fn handler_texts(event: &Value) -> Vec<String> {
    event["handlers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|run| {
            let mut text = format!(
                "{}@{}",
                run["fn"].as_str().unwrap_or("?"),
                run["on"].as_str().unwrap_or("?")
            );
            if run["prevented"] == true {
                text.push_str("!prevent");
            }
            if run["stopped"] == true {
                text.push_str("!stop");
            }
            if let Some(threw) = run["threw"].as_str() {
                text.push_str(&format!("!threw({threw})"));
            }
            text
        })
        .collect()
}

/// One `do` step as text, in the order it matters: the verdict; what the verb answered; what
/// it did to the app (document, selection, screen, state, vault); then the rows that changed,
/// or everything a screen it opened shows, one line per row with every field. Nothing is
/// dropped: a field with no rendering of its own prints as `key value`, so a field a verb starts
/// sending shows up before anyone writes one. `{"json":true}` gives the receipt itself.
/// Without its rows (`rows` false) a step says only how many it touched, for a batch that
/// shows the screen once at its end.
pub(crate) fn render_step(receipt: &Value, rows: bool) -> String {
    let verb = receipt["verb"].as_str().unwrap_or("?");
    let status = receipt["status"].as_u64().unwrap_or(0);
    let ok = status < 400;
    let body = &receipt["result"];
    let mut out = if ok {
        format!("OK {verb}")
    } else {
        let why = body["error"]
            .as_str()
            .map_or_else(|| compact(body), str::to_string);
        format!("REFUSED {status} {verb}: {why}")
    };
    // The page's own bookkeeping, which `events` and `diff '{"action":N}'` take.
    if let Some(action) = body.get("action") {
        out.push_str(&format!(" · action {action}"));
    }
    if let Some(events) = body.get("events") {
        out.push_str(&format!(" · events {events}"));
    }
    let diff = &body["diff"];
    if let (Some(before), Some(after)) = (diff.get("before"), diff.get("after")) {
        out.push_str(&format!(" · snapshots {before} → {after}"));
    }
    out.push('\n');
    // What the verb answered: the note it made, the text it selected, the editor it left.
    let rendered = |key: &str, value: &Value| match key {
        "diff" | "touch" | "keys" | "wrote" | "changedSinceLast" | "action" | "events"
        | "reach" => true,
        "ok" => value.as_bool() == Some(ok),
        "verb" => value.as_str() == Some(verb),
        "error" => !ok,
        _ => false,
    };
    for (key, value) in body.as_object().into_iter().flatten() {
        if !rendered(key, value) && !is_empty(value) {
            out.push_str(&format!("{key} {}\n", quoted(value)));
        }
    }
    // A refusal for a place off screen: the batch that brings it on, as a person would.
    if let Some(reach) = body["reach"].as_array() {
        out.push_str(&format!("reach it: {}\n", batch_call(reach)));
    }
    out.push_str(&screen::render_touch(&body["touch"]));
    out.push_str(&screen::render_keys(&body["keys"]));
    let wrote = &body["wrote"];
    if wrote.is_object() {
        out.push_str(&format!(
            "wrote @{} -{} +{}\n",
            wrote["from"],
            quoted(&wrote["removed"]),
            quoted(&wrote["inserted"])
        ));
    }
    let diff_text = |diff: &Value| {
        if rows {
            return render_diff(diff);
        }
        let mut text = render_diff_facts(diff);
        match row_count(diff) {
            Some(count) => text.push_str(&format!("{count}\n")),
            None if text.is_empty() => text.push_str("no change\n"),
            None => {}
        }
        text
    };
    if ok || diff.is_object() {
        out.push_str(&diff_text(diff));
    }
    let moved = &body["changedSinceLast"];
    if moved.is_object() {
        out.push_str(&format!(
            "before this, the page changed on its own (action {}):\n",
            moved["action"]
        ));
        for line in diff_text(&moved["diff"]).lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    out
}

/// A gesture's answer, verdict first as a `do` step's: `OK click · action 12 · events 3 ·
/// snapshots 4 → 5` for one the page traced, `OK tap · screen list` for one on a phone's native
/// screen, then what it did; a refusal as a step's, with the batch that reaches its place.
pub(crate) fn render_gesture(name: &str, reply: &Reply) -> String {
    let body = &reply.body;
    if reply.status != 200 {
        return render_step(
            &json!({ "verb": name, "status": reply.status, "result": body }),
            true,
        );
    }
    let header = if body["trace"].is_array() {
        format!(
            "action {} · events {} · snapshots {} → {}",
            body["id"],
            event_count(body),
            body["before"],
            body["after"]
        )
    } else {
        format!("screen {}", body["screen"].as_str().unwrap_or("?"))
    };
    format!("OK {name} · {header}\n{}", render_effects(body))
}

/// An action record (`diff {"action":N}`): header, its events (when present), its diff.
pub(crate) fn render_action(body: &Value) -> String {
    if body["pending"] == json!(true) {
        return format!(
            "action {} {} still running · snapshot {} taken before it\n",
            body["id"],
            body["verb"].as_str().unwrap_or("?"),
            body["before"]
        );
    }
    format!(
        "action {} {}{} · snapshots {} → {} · events {}\n{}",
        body["id"],
        body["kind"].as_str().unwrap_or("?"),
        body["verb"]
            .as_str()
            .map(|v| format!(" {v}"))
            .unwrap_or_default(),
        body["before"],
        body["after"],
        event_count(body),
        render_effects(body)
    )
}

/// What an action did: where a touch landed or what took the keys, the page's events, the
/// diff, and, when nothing changed, why.
fn render_effects(body: &Value) -> String {
    let mut out = screen::render_touch(&body["touch"]);
    out.push_str(&screen::render_keys(&body["keys"]));
    if let Some(events) = body["trace"].as_array() {
        out.push_str(&render_events(events, true));
    }
    let diff = render_diff(&body["diff"]);
    out.push_str(&diff);
    if diff == "no change\n" {
        if let Some(hint) = unhandled_click_hint(body["trace"].as_array())
            .or_else(|| screen::not_a_control_hint(&body["touch"]))
        {
            out.push_str(&hint);
        }
    }
    out
}

/// The click landed on something with no click handler: the usual miss, a
/// rect's corner hitting the container's padding. Name it, and the fix.
fn unhandled_click_hint(trace: Option<&Vec<Value>>) -> Option<String> {
    let click = trace?
        .iter()
        .rev()
        .find(|event| event["type"] == json!("click"))?;
    if click["handlers"]
        .as_array()
        .is_some_and(|handlers| !handlers.is_empty())
    {
        return None;
    }
    Some(format!(
        "the click landed on {} {}, which has no click handler — aim with {{\"ref\":\"eN\"}} at the element you meant\n",
        click["target"].as_str().unwrap_or("?"),
        click["component"].as_str().unwrap_or("-")
    ))
}
