//! `file`: a note's markdown as it is on disk, read by the app once the open note's edits are
//! saved (unless `"save":false`). The app sends the whole file; narrowing it to lines or matches
//! is this CLI's alone.

use super::*;

const FILE_USAGE: &str = "file takes {\"noteId\":\"…\"}. It first saves the open note's \
     pending edits, as autosave would, so they are in what it prints, and refuses (409) when \
     the note asked for has edits that cannot be saved. \"save\":false reads the disk as it \
     is instead: nothing is saved, and any edits not saved yet (waiting for autosave, or a save \
     that failed) are not in it. To narrow it: \"lines\":\"40-60\" (or \"40\", or \"40-\" to \
     the end), \"find\":\"text\" and \"around\":N lines either side of each match";

/// What a `"save":false` read says about itself, in its header and its past-the-end refusal.
const READ_WITHOUT_SAVING: &str =
    "read without saving first: any edits not saved yet are not in it";

/// `file {"noteId", "save"?, "lines"?, "find"?, "around"?}`. Only the id and `save` travel to
/// the app.
pub(crate) fn file(target: &Target, args: &Value) -> Result<Reply, String> {
    let query = match FileQuery::parse(args) {
        Ok(query) => query,
        Err(error) => return Ok(Reply::refusal(400, error)),
    };
    let reply = call(
        target,
        "file",
        &json!({ "noteId": args["noteId"], "save": query.save }),
    )?;
    if reply.status != 200 {
        return Ok(reply);
    }
    Ok(match query.apply(&reply.body) {
        Ok(body) => Reply { status: 200, body },
        Err(error) => Reply::refusal(400, error),
    })
}

/// Whether the app saves the open note first, and which of the file's lines to print: a range,
/// the lines holding a string, and how many lines either side of each of those. Lines count
/// from 1, as an editor's gutter does.
pub(crate) struct FileQuery {
    save: bool,
    lines: Option<(usize, usize)>,
    find: Option<String>,
    around: usize,
}

impl FileQuery {
    pub(crate) fn parse(args: &Value) -> Result<FileQuery, String> {
        let fields = args.as_object().ok_or(FILE_USAGE)?;
        let known = ["noteId", "save", "lines", "find", "around"];
        if args["noteId"].as_str().is_none_or(str::is_empty)
            || fields.keys().any(|key| !known.contains(&key.as_str()))
        {
            return Err(FILE_USAGE.into());
        }
        let save = match &args["save"] {
            Value::Null => true,
            Value::Bool(save) => *save,
            _ => return Err(FILE_USAGE.into()),
        };
        let lines = match &args["lines"] {
            Value::Null => None,
            Value::String(range) => Some(parse_line_range(range).ok_or(FILE_USAGE)?),
            _ => return Err(FILE_USAGE.into()),
        };
        let find = match &args["find"] {
            Value::Null => None,
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            _ => return Err(FILE_USAGE.into()),
        };
        let around = match &args["around"] {
            Value::Null => 0,
            around if find.is_some() => around.as_u64().ok_or(FILE_USAGE)? as usize,
            _ => {
                return Err("file: \"around\" widens each match of \"find\"; give find too".into())
            }
        };
        Ok(FileQuery {
            save,
            lines,
            find,
            around,
        })
    }

    /// The app's `{noteId, text}` as the lines asked for, each `{line, text}`, with what was
    /// asked and what matched beside them.
    pub(crate) fn apply(&self, body: &Value) -> Result<Value, String> {
        let text = body["text"].as_str().unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        let count = all.len();
        let (first, last) = match self.lines {
            None => (1, count),
            Some((first, _)) if first > count => {
                let mut refusal = format!(
                    "file: line {first} is past the end; {} has {count} lines",
                    body["noteId"]
                );
                if !self.save {
                    refusal.push_str(&format!(", {READ_WITHOUT_SAVING}"));
                }
                return Err(refusal);
            }
            Some((first, last)) => (first, last.min(count)),
        };
        let mut out = json!({ "noteId": body["noteId"], "lineCount": count });
        // The numbered lines cannot show whether the last one ends in a newline.
        if !text.is_empty() && !text.ends_with('\n') {
            out["noFinalNewline"] = json!(true);
        }
        if !self.save {
            out["save"] = json!(false);
        }
        if self.lines.is_some() {
            out["range"] = json!([first, last]);
        }
        let shown: Vec<usize> = match &self.find {
            None => (first..=last).collect(),
            Some(needle) => {
                let matches: Vec<usize> = (first..=last)
                    .filter(|&line| all[line - 1].contains(needle.as_str()))
                    .collect();
                let mut shown = std::collections::BTreeSet::new();
                for &line in &matches {
                    shown.extend(
                        line.saturating_sub(self.around).max(first)
                            ..=line.saturating_add(self.around).min(last),
                    );
                }
                out["find"] = json!(needle);
                out["matches"] = json!(matches);
                if self.around > 0 {
                    out["around"] = json!(self.around);
                }
                shown.into_iter().collect()
            }
        };
        out["lines"] = shown
            .into_iter()
            .map(|line| json!({ "line": line, "text": all[line - 1] }))
            .collect();
        Ok(out)
    }
}

/// `"40-60"`, `"40"`, or `"40-"` for line 40 to the end.
fn parse_line_range(range: &str) -> Option<(usize, usize)> {
    let number = |text: &str| text.trim().parse::<usize>().ok().filter(|&line| line >= 1);
    match range.split_once('-') {
        None => number(range).map(|line| (line, line)),
        Some((first, "")) => number(first).map(|first| (first, usize::MAX)),
        Some((first, last)) => {
            let (first, last) = (number(first)?, number(last)?);
            (first <= last).then_some((first, last))
        }
    }
}

/// A header saying how much of the file this is, then each line as `N│text`; a gap between
/// shown lines is one `…` line. The numbers are the file's lines, not `doc`'s blocks.
pub(crate) fn render_file(body: &Value) -> String {
    let count = body["lineCount"].as_u64().unwrap_or(0);
    let mut out = format!(
        "{} · {count} line{}",
        body["noteId"].as_str().unwrap_or(""),
        if count == 1 { "" } else { "s" }
    );
    if body["noFinalNewline"] == true {
        out.push_str(" · no newline at end");
    }
    if body["save"] == false {
        out.push_str(&format!(" · {READ_WITHOUT_SAVING}"));
    }
    if let Some([first, last]) = body["range"].as_array().map(Vec::as_slice) {
        out.push_str(&format!(" · lines {first}–{last}"));
    }
    if let Some(needle) = body["find"].as_str() {
        let matches: Vec<String> = body["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .map(Value::to_string)
            .collect();
        let needle = Value::String(needle.into());
        out.push_str(&match matches.len() {
            0 => format!(" · no line contains {needle}"),
            1 => format!(" · {needle} on line {}", matches[0]),
            _ => format!(" · {needle} on lines {}", matches.join(", ")),
        });
        if let Some(around) = body["around"].as_u64() {
            out.push_str(&format!(", {around} around each"));
        }
    }
    out.push('\n');
    let width = count.to_string().len();
    let mut previous: Option<u64> = None;
    for line in body["lines"].as_array().into_iter().flatten() {
        let number = line["line"].as_u64().unwrap_or(0);
        if previous.is_some_and(|previous| number > previous + 1) {
            out.push_str(&format!("{:>width$}\n", "…"));
        }
        previous = Some(number);
        out.push_str(&format!(
            "{number:>width$}│{}\n",
            line["text"].as_str().unwrap_or("")
        ));
    }
    out
}
