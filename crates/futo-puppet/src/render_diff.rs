//! A diff as change lines: the screen it moved to, the document, the selection, the app's state
//! and vault, then the rows that came, went or changed.

use super::*;

pub(crate) fn selection_text(value: &Value) -> String {
    if value.is_null() {
        return "none".into();
    }
    format!("{}-{}", value["from"], value["to"])
}

/// `screen "list" → "editor:a"` when the diff moved screens, else nothing.
pub(crate) fn screen_line(diff: &Value) -> String {
    diff["screen"].as_array().map_or(String::new(), |screen| {
        format!("screen {} → {}\n", quoted(&screen[0]), quoted(&screen[1]))
    })
}

/// A row as a receipt names it: `e3 button "Close"`.
pub(crate) fn row_label(row: &Value) -> String {
    format!(
        "{} {} {}",
        row["ref"].as_str().unwrap_or("?"),
        row["role"].as_str().unwrap_or("?"),
        quoted(&row["text"])
    )
}

pub(crate) fn render_diff(diff: &Value) -> String {
    let out = render_diff_facts(diff) + &render_diff_rows(diff);
    if out.is_empty() {
        return "no change\n".into();
    }
    out
}

/// What a step did beyond the rows on screen: the screen it moved to, the document, the
/// selection, the app's state and vault, and any part with no rendering of its own.
pub(crate) fn render_diff_facts(diff: &Value) -> String {
    let mut out = String::new();
    out.push_str(&screen_line(diff));
    if let Some(doc) = diff.get("doc").filter(|d| d.is_object()) {
        // Only where: a person sees none of a change off screen.
        if doc["offScreen"] == json!(true) {
            let lines = if doc["line"] == doc["to"] {
                format!("L{}", doc["line"])
            } else {
                format!("L{}–{}", doc["line"], doc["to"])
            };
            out.push_str(&format!("doc {lines} changed off screen\n"));
        } else {
            out.push_str(&format!(
                "doc L{} -{} +{}\n",
                doc["line"],
                quoted(&doc["removed"]),
                quoted(&doc["inserted"])
            ));
        }
    }
    if let Some(selection) = diff["selection"].as_array() {
        out.push_str(&format!(
            "selection {} → {}\n",
            selection_text(&selection[0]),
            selection_text(&selection[1])
        ));
    }
    out.push_str(&app::render(diff));
    // A part of the diff with no rendering of its own, as itself: nothing is dropped. The
    // snapshot ids are the receipt header's.
    const RENDERED: [&str; 9] = [
        "screen",
        "doc",
        "selection",
        "state",
        "vault",
        "now",
        "elements",
        "before",
        "after",
    ];
    for (key, value) in diff.as_object().into_iter().flatten() {
        if !RENDERED.contains(&key.as_str()) && !is_empty(value) {
            out.push_str(&format!("{key} {}\n", compact(value)));
        }
    }
    out
}

/// The rows: everything a screen it opened shows, or the rows that came, went or changed.
pub(crate) fn render_diff_rows(diff: &Value) -> String {
    let mut out = String::new();
    // A step that opened another screen: everything that screen now shows.
    if let Some(now) = diff["now"].as_array() {
        for line in screen::render_outline("", now, &[]).lines().skip(1) {
            out.push_str(line);
            out.push('\n');
        }
    }
    let elements = &diff["elements"];
    // Where on screen, as `elements` groups it: "Delete" alone does not say which menu.
    let section = |row: &Value| {
        row["section"]
            .as_str()
            .filter(|section| !section.is_empty())
            .map_or(String::new(), |section| format!("{section}: "))
    };
    for row in elements["added"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "+ {}{}",
            section(row),
            render_element_rows(std::slice::from_ref(row))
        ));
    }
    // A row that went is said by its going: what it was, grouped by where it was. Its rect and
    // handlers describe a screen that is no longer there, and a dialog covering the window
    // takes every row behind it at once.
    let mut gone: Vec<(String, Vec<String>)> = Vec::new();
    for row in elements["removed"].as_array().into_iter().flatten() {
        let name = row_label(row);
        let at = section(row);
        match gone.iter_mut().find(|(section, _)| *section == at) {
            Some((_, names)) => names.push(name),
            None => gone.push((at, vec![name])),
        }
    }
    for (at, names) in gone {
        out.push_str(&format!("- {at}{}\n", names.join(", ")));
    }
    for change in elements["changed"].as_array().into_iter().flatten() {
        let mut line = format!(
            "~ {}{} {}{} {}",
            section(change),
            change["ref"].as_str().unwrap_or("?"),
            match change["component"].as_str().unwrap_or("-") {
                "" => String::new(),
                component => format!("{component} "),
            },
            change["role"].as_str().unwrap_or("?"),
            quoted(&change["text"])
        );
        if let Some(rect) = change["rect"].as_array() {
            let r = |v: &Value| format!("{},{} {}×{}", v["x"], v["y"], v["w"], v["h"]);
            line.push_str(&format!("  rect {} → {}", r(&rect[0]), r(&rect[1])));
        }
        if let Some(flags) = change["flags"].as_array() {
            line.push_str(&format!(
                "  flags {} → {}",
                compact(&flags[0]),
                compact(&flags[1])
            ));
        }
        if let Some(text) = change["textChange"].as_array() {
            line.push_str(&format!(
                "  text {} → {}",
                quoted(&text[0]),
                quoted(&text[1])
            ));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// How many rows a step's diff names: in a batch, which shows the screen once, as the batch
/// left it, this line is what each step did to the rows.
pub(crate) fn row_count(diff: &Value) -> Option<String> {
    if let Some(now) = diff["now"].as_array() {
        return Some(format!("rows: {} on the screen it opened", now.len()));
    }
    let count = |change: &str| diff["elements"][change].as_array().map_or(0, Vec::len);
    let (added, removed, changed) = (count("added"), count("removed"), count("changed"));
    (added + removed + changed > 0).then(|| format!("rows +{added} -{removed} ~{changed}"))
}

pub(crate) fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}
