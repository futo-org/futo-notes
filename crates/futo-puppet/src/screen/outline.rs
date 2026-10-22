//! Rows as an outline, the way `elements` prints them: grouped by the part of the screen they
//! are in, in reading order, each scrolling section saying where more of it is.

use super::*;

/// Where more of a scrolling section is, in words: `rows 7–14 of 18 · more above and below`.
fn scroll_summary(entry: &Value) -> String {
    let mut parts = Vec::new();
    let mut up = entry["up"] == json!(true);
    let mut down = entry["down"] == json!(true);
    if let (Some(first), Some(last), Some(total)) = (
        entry["first"].as_u64(),
        entry["last"].as_u64(),
        entry["total"].as_u64(),
    ) {
        parts.push(format!("rows {first}–{last} of {total}"));
        // The rows say it better than the offset: a list padded for a floating button
        // still scrolls a little past its last row, which holds nothing more.
        up &= first > 1;
        down &= last < total;
    }
    let ways: Vec<&str> = [
        (up, "above"),
        (down, "below"),
        (entry["left"] == json!(true), "to the left"),
        (entry["right"] == json!(true), "to the right"),
    ]
    .iter()
    .filter(|(more, _)| *more)
    .map(|(_, word)| *word)
    .collect();
    match ways.as_slice() {
        [] => {}
        [one] => parts.push(format!("more {one}")),
        [first, second] => parts.push(format!("more {first} and {second}")),
        many => parts.push(format!("more {}", many.join(", "))),
    }
    parts.join(" · ")
}

/// Rows grouped by the part of the screen they are in, in reading order: sections by
/// where they start on screen, rows within one top to bottom, then left to right. Each
/// section that scrolls says where more of it is.
pub(crate) fn render_outline(header: &str, rows: &[Value], scroll: &[Value]) -> String {
    let at = |row: &Value, key: &str| row["rect"][key].as_f64().unwrap_or(0.0);
    let mut sections: Vec<(String, Vec<Value>)> = Vec::new();
    for row in rows {
        let name = row["section"].as_str().unwrap_or("content").to_string();
        match sections.iter_mut().find(|(section, _)| *section == name) {
            Some((_, members)) => members.push(row.clone()),
            None => sections.push((name, vec![row.clone()])),
        }
    }
    let top = |members: &[Value]| {
        members
            .iter()
            .map(|row| at(row, "y"))
            .fold(f64::MAX, f64::min)
    };
    sections.sort_by(|a, b| top(&a.1).total_cmp(&top(&b.1)));
    let mut out = format!("{header}\n");
    for (name, mut members) in sections {
        members.sort_by(|a, b| {
            at(a, "y")
                .total_cmp(&at(b, "y"))
                .then(at(a, "x").total_cmp(&at(b, "x")))
        });
        let summary = scroll
            .iter()
            .find(|entry| entry["section"].as_str() == Some(name.as_str()))
            .map(scroll_summary)
            .filter(|summary| !summary.is_empty());
        match summary {
            Some(summary) => out.push_str(&format!("{name} · {summary}\n")),
            None => out.push_str(&format!("{name}\n")),
        }
        for line in render_element_rows(&members).lines() {
            out.push_str(&format!("  {line}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outline_reads_top_to_bottom_by_section_with_where_each_list_scrolls() {
        let row = |reference: &str, section: &str, y: i64| {
            json!({"ref": reference, "component": "", "role": "row", "text": reference,
                   "handlers": ["tap"], "flags": [], "section": section,
                   "rect": {"x": 16, "y": y, "w": 370, "h": 52}})
        };
        let rows = [
            row("n3", "list", 220),
            row("n1", "top bar", 66),
            row("n2", "list", 168),
            row("n9", "keyboard toolbar", 828),
        ];
        let scroll = [
            json!({"section": "list", "up": true, "down": true, "first": 7, "last": 8, "total": 18}),
            json!({"section": "keyboard toolbar", "right": true}),
        ];
        let outline = render_outline("screen folder:recipes", &rows, &scroll);
        let lines: Vec<&str> = outline.lines().map(str::trim_end).collect();
        assert_eq!(lines[0], "screen folder:recipes");
        assert_eq!(lines[1], "top bar");
        assert!(lines[2].trim_start().starts_with("n1"));
        assert_eq!(lines[3], "list · rows 7–8 of 18 · more above and below");
        assert!(lines[4].trim_start().starts_with("n2") && lines[5].trim_start().starts_with("n3"));
        assert_eq!(lines[6], "keyboard toolbar · more to the right");
        // Bottom padding scrolls past the last row; nothing more is there.
        let end = json!({"section": "list", "up": true, "down": true, "first": 15, "last": 19, "total": 19});
        assert_eq!(scroll_summary(&end), "rows 15–19 of 19 · more above");
    }
}
