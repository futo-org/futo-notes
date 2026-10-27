//! What reaches stdout and stderr.
//!
//! Command data goes to stdout; prompts, progress, and warnings go to stderr.
//! `--json` replaces human output with exactly one JSON object. Nothing here
//! emits a color or terminal control sequence, and user data printed in human
//! rows has control characters escaped — on screen only, never in a stored
//! value or in `read`.
//!
//! Every write ignores its own failure: a closed terminal must not turn into a
//! panic (the reason the workspace denies `println!`).

use std::io::Write;

use serde_json::{json, Value};

use crate::error::CliError;

pub const SCHEMA_VERSION: u32 = 1;

pub struct Output {
    json: bool,
}

impl Output {
    pub fn new(json: bool) -> Self {
        Self { json }
    }

    pub fn is_json(&self) -> bool {
        self.json
    }

    /// A warning or progress line on stderr. Silent under `--json`, whose
    /// stdout object is the whole result.
    pub fn note(&self, message: &str) {
        if !self.json {
            stderr_line(&display(message));
        }
    }

    /// The success result: `human` prints the human form, JSON prints `data`.
    pub fn success(&self, data: Value, human: impl FnOnce()) {
        if self.json {
            stdout_line(
                &json!({"schemaVersion": SCHEMA_VERSION, "ok": true, "data": data}).to_string(),
            );
        } else {
            human();
        }
    }

    pub fn failure(&self, error: &CliError) {
        if self.json {
            let mut object = json!({
                "schemaVersion": SCHEMA_VERSION,
                "ok": false,
                "error": {"code": error.code.as_str(), "message": error.message},
            });
            if let Some(data) = &error.data {
                object["data"] = data.clone();
            }
            stdout_line(&object.to_string());
        } else {
            stderr_line(&display(&error.message));
        }
    }
}

pub fn stdout_line(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{text}");
    let _ = stdout.flush();
}

pub fn stdout_bytes(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

pub fn stderr_line(text: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{text}");
}

/// Escapes terminal control characters for on-screen display, so a note title
/// cannot move the cursor or recolor the terminal. Newlines and tabs stay as
/// they are; everything else in C0, DEL, and C1 becomes a visible `\u{…}`.
pub fn display(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        let code = character as u32;
        let control = (code < 0x20 && character != '\n' && character != '\t')
            || code == 0x7f
            || (0x80..0xa0).contains(&code);
        if control {
            out.push_str(&format!("\\u{{{code:x}}}"));
        } else {
            out.push(character);
        }
    }
    out
}

/// A single-line display form for a row, which no newline may split.
pub fn display_inline(text: &str) -> String {
    display(text).replace('\n', "\\n").replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_are_escaped_for_display_only() {
        assert_eq!(display("a\u{1b}[31mb"), "a\\u{1b}[31mb");
        assert_eq!(display("line\nnext\ttab"), "line\nnext\ttab");
        assert_eq!(display("\u{9b}x\u{7f}"), "\\u{9b}x\\u{7f}");
        assert_eq!(display("héllo ✓"), "héllo ✓");
        assert_eq!(display_inline("a\nb"), "a\\nb");
    }
}
