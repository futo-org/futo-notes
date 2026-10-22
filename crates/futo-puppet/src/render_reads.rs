//! Rendering the reads: `elements` and `actions` are scanned, so they print as tables; everything
//! else is looked up, so it prints as JSON (`notes`, `search` and `doc` have their own text).

use super::*;

pub(crate) fn render_actions(body: &Value) -> String {
    let mut out = format!("screen: {}\n", body["screen"].as_str().unwrap_or("unknown"));
    let actions = body["actions"].as_array().cloned().unwrap_or_default();
    let width = actions
        .iter()
        .filter_map(|a| a["name"].as_str())
        .map(str::len)
        .max()
        .unwrap_or(0);
    for action in &actions {
        // A convenience verb (a fast write, an instant scroll) is not input a person makes;
        // say so where the agent picks its verb.
        let kind = if action["convenience"] == json!(true) {
            "  (convenience, not real input)"
        } else {
            ""
        };
        let line = format!(
            "{:<width$}  {}{kind}",
            action["name"].as_str().unwrap_or("?"),
            parameters(&action["schema"])
        );
        out.push_str(line.trim_end());
        out.push('\n');
        for (argument, steps) in action["shortcuts"].as_object().into_iter().flatten() {
            out.push_str(&format!(
                "{:width$}    {argument}: shortcut, then {}\n",
                "",
                shortcut_text(argument, steps)
            ));
        }
    }
    out
}

/// A verb's arguments as an agent writes them: `{noteId: string, mode?: current|foreground}`,
/// the required ones first, a value list in place of `string`. Empty when it takes none.
pub(crate) fn parameters(schema: &Value) -> String {
    let none = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&none);
    let required = |key: &str| {
        schema["required"]
            .as_array()
            .is_some_and(|keys| keys.contains(&json!(key)))
    };
    let (mut entries, optional): (Vec<_>, Vec<_>) =
        properties.iter().partition(|(key, _)| required(key));
    entries.extend(optional);
    let entries: Vec<String> = entries
        .into_iter()
        .map(|(key, property)| {
            let values: Option<Vec<&str>> = property["enum"]
                .as_array()
                .map(|allowed| allowed.iter().filter_map(Value::as_str).collect());
            let kind = values.map_or_else(
                || property["type"].as_str().unwrap_or("any").to_string(),
                |values| values.join("|"),
            );
            let mark = if required(key) { "" } else { "?" };
            format!("{key}{mark}: {kind}")
        })
        .collect();
    if entries.is_empty() {
        String::new()
    } else {
        format!("{{{}}}", entries.join(", "))
    }
}

pub(crate) fn render_elements(body: &Value) -> String {
    let rows = body["elements"].as_array().cloned().unwrap_or_default();
    let scroll = body["scroll"].as_array().cloned().unwrap_or_default();
    // A phone reports its screen and its units; the desktop page its snapshot and viewport.
    let header = if body["size"].is_object() {
        let size = &body["size"];
        format!(
            "screen {} · {} on screen · {}×{} {}",
            body["screen"].as_str().unwrap_or("?"),
            rows.len(),
            size["w"],
            size["h"],
            size["unit"].as_str().unwrap_or("")
        )
    } else {
        format!(
            "snapshot {} · {} on screen · {}×{} px",
            body["snapshot"],
            rows.len(),
            body["viewport"]["w"],
            body["viewport"]["h"]
        )
    };
    screen::render_outline(&header, &rows, &scroll)
}

/// What a handler lets a person do, in their words: a page handler is `event=function`,
/// and which function it is stays in `show`, `at` and `events`, where a trace needs it.
/// A native row's actions (`tap`, `hold`, `actions=…`) already are words.
fn plain_action(handler: &str) -> &str {
    let event = handler.split_once('=').map_or(handler, |(event, _)| event);
    match event {
        "click" | "mouseup" | "pointerup" | "auxclick" => "click",
        "dblclick" => "double-click",
        "contextmenu" => "right-click",
        "keydown" | "keyup" | "keypress" | "beforeinput" | "input" => "keys",
        "mousedown" | "pointerdown" | "touchstart" => "press",
        "dragstart" | "drop" | "dragover" | "dragenter" => "drag",
        "wheel" | "scroll" => "scroll",
        "focus" | "focusin" | "blur" | "focusout" => "focus",
        "mouseenter" | "mouseover" | "pointerenter" | "pointerover" | "mouseleave" => "hover",
        _ if handler.contains('=') && !handler.starts_with("actions=") => event,
        _ => handler,
    }
}

pub(crate) fn render_element_rows(rows: &[Value]) -> String {
    let cells: Vec<[String; 5]> = rows
        .iter()
        .map(|row| {
            let handlers = row["handlers"].as_array().cloned().unwrap_or_default();
            let flags = row["flags"].as_array().cloned().unwrap_or_default();
            let mut behaviour: Vec<&str> = Vec::new();
            for word in handlers
                .iter()
                .filter_map(Value::as_str)
                .map(plain_action)
                .chain(flags.iter().filter_map(Value::as_str))
            {
                if !behaviour.contains(&word) {
                    behaviour.push(word);
                }
            }
            let behaviour = behaviour.join(" ");
            let rect = &row["rect"];
            [
                row["ref"].as_str().unwrap_or("?").to_string(),
                // The source file names the component; `.svelte` on every row says nothing.
                row["component"]
                    .as_str()
                    .map_or("-", |component| component.trim_end_matches(".svelte"))
                    .to_string(),
                row["role"].as_str().unwrap_or("?").to_string(),
                format!("\"{}\"", row["text"].as_str().unwrap_or("")),
                format!(
                    "{}{}  {},{} {}×{}{}{}",
                    match (row["note"].as_str(), row["folder"].as_str()) {
                        (Some(note), _) => format!("note={note} "),
                        (_, Some(folder)) => format!("folder={folder} "),
                        _ => String::new(),
                    },
                    behaviour,
                    rect["x"],
                    rect["y"],
                    rect["w"],
                    rect["h"],
                    // Something covers its centre: this is where a click reaches it.
                    match (row["aim"]["x"].as_f64(), row["aim"]["y"].as_f64()) {
                        (Some(x), Some(y)) => format!(" aim {x},{y}"),
                        _ => String::new(),
                    },
                    // The verb that does what touching it does: use it instead of aiming.
                    row["verb"]
                        .as_str()
                        .map_or(String::new(), |verb| format!("  → {verb}"))
                ),
            ]
        })
        .collect();
    let widths: Vec<usize> = (0..4)
        .map(|i| {
            cells
                .iter()
                .map(|c| c[i].chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let mut out = String::new();
    for cell in &cells {
        for (i, width) in widths.iter().enumerate() {
            // Native rows have no component (native.rs sends it empty).
            if *width == 0 {
                continue;
            }
            out.push_str(&format!("{:<w$}  ", cell[i], w = width));
        }
        out.push_str(cell[4].trim_start());
        out.push('\n');
    }
    out
}

/// The vault as the store knows it, which is not what the tree draws: everything
/// inside a collapsed folder is absent from every DOM query, and deleting a
/// folder's last note deletes the folder with it. Counts first — that is usually
/// the whole question.
pub(crate) fn render_notes(body: &Value) -> String {
    let notes = body["notes"].as_array().cloned().unwrap_or_default();
    let folders = body["folders"].as_array().cloned().unwrap_or_default();
    let mut out = format!(
        "{} notes · {} folders · the vault, whatever the sidebar is showing\n",
        notes.len(),
        folders.len()
    );
    for folder in &folders {
        let path = folder.as_str().unwrap_or("");
        let holds_a_note = notes
            .iter()
            .filter_map(Value::as_str)
            .any(|note| note.starts_with(&format!("{path}/")));
        out.push_str(&format!(
            "folder  {path}{}\n",
            if holds_a_note { "" } else { "   (no notes)" }
        ));
    }
    for note in &notes {
        out.push_str(&format!("note    {}\n", note.as_str().unwrap_or("")));
    }
    out
}

pub(crate) fn render_search(body: &Value) -> String {
    let hits = body["hits"].as_array().cloned().unwrap_or_default();
    let mut out = format!("{} hits for {} · best first\n", hits.len(), body["query"]);
    for (rank, hit) in hits.iter().enumerate() {
        out.push_str(&format!(
            "{:>3}  {}\n",
            rank + 1,
            hit.as_str().unwrap_or("")
        ));
    }
    out
}

/// A line's text or saved markdown as one line of output: a newline in it shows as `⏎`.
fn one_line(text: &str) -> String {
    text.replace('\n', "⏎")
}

/// One document line: `L{line} {at}-{end}│{kind}│{text}`, its saved markdown under it where
/// that differs (`md│…`), a nested list item's kind indented.
fn doc_line(line: &Value, width: usize) -> String {
    let indent = "  ".repeat(line["indent"].as_u64().unwrap_or(0) as usize);
    let span = format!("{}-{}", line["at"], line["end"]);
    let mut out = format!(
        "L{:<3} {:>width$}│{indent}{}│{}\n",
        line["line"].to_string(),
        span,
        line["kind"].as_str().unwrap_or(""),
        one_line(line["text"].as_str().unwrap_or(""))
    );
    if let Some(md) = line["md"].as_str() {
        out.push_str(&format!(
            "{:>pad$}md│{}\n",
            "",
            one_line(md),
            pad = width + 3
        ));
    }
    out
}

pub(crate) fn render_doc(body: &Value) -> String {
    if let Some(runs) = body["runs"].as_array() {
        let mut out = format!("docVersion {}\n", body["docVersion"]);
        out.push_str(&doc_line(body, 0));
        for run in runs {
            let at = run["at"].to_string();
            let marks = run["marks"]
                .as_array()
                .map(|marks| {
                    marks
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            match run["node"].as_str() {
                Some(node) => {
                    let attrs: Vec<String> = run
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter(|(key, _)| !["at", "node", "text"].contains(&key.as_str()))
                        .map(|(key, value)| format!("{key}={}", quoted(value)))
                        .collect();
                    out.push_str(&format!(
                        "  {at:>5} {node} {}{}\n",
                        run["text"]
                            .as_str()
                            .map(|t| format!("{t:?} "))
                            .unwrap_or_default(),
                        attrs.join(" ")
                    ));
                }
                None => out.push_str(&format!(
                    "  {at:>5} {:?}{}\n",
                    run["text"].as_str().unwrap_or(""),
                    if marks.is_empty() {
                        String::new()
                    } else {
                        format!(" {marks}")
                    }
                )),
            }
        }
        for tag in body["tags"].as_array().into_iter().flatten() {
            out.push_str(&format!(
                "  tag {}-{} {}\n",
                tag["from"],
                tag["to"],
                tag["tag"].as_str().unwrap_or("")
            ));
        }
        return out;
    }
    let lines = body["lines"].as_array().cloned().unwrap_or_default();
    let width = lines
        .iter()
        .map(|l| format!("{}-{}", l["at"], l["end"]).len())
        .max()
        .unwrap_or(1);
    let shows = match (
        body["onScreen"]["first"].as_u64(),
        body["onScreen"]["last"].as_u64(),
    ) {
        (Some(first), Some(last)) => {
            let more = match (body["more"]["above"] == true, body["more"]["below"] == true) {
                (true, true) => " · more above and below",
                (true, false) => " · more above",
                (false, true) => " · more below",
                (false, false) => "",
            };
            format!("lines {first}–{last} on screen{more}")
        }
        _ => "no line on screen".to_string(),
    };
    let mut out = format!(
        "docVersion {} · {shows} · line at-end│kind│text, md│ the saved markdown where it differs\n",
        body["docVersion"],
    );
    for line in &lines {
        out.push_str(&doc_line(line, width));
    }
    out
}

pub(crate) fn render_query(command: &str, body: &Value) -> String {
    match command {
        "actions" => render_actions(body),
        "elements" if body["added"].is_array() => {
            format!(
                "snapshot {} · since {}\n{}",
                body["snapshot"],
                body["since"],
                render_diff(&json!({ "elements": body }))
            )
        }
        "elements" => render_elements(body),
        "notes" => render_notes(body),
        "search" => render_search(body),
        "doc" => render_doc(body),
        "events" if body["events"].is_array() => {
            render_events(body["events"].as_array().unwrap(), false)
        }
        "diff" if body["kind"].is_string() => render_action(body),
        "diff" => render_diff(body),
        _ => pretty(body) + "\n",
    }
}
