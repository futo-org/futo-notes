//! Line-start escapes the engine writes speculatively while a line is typed,
//! and their removal once the line no longer needs them.
use super::*;

impl EditorSession {
    /// The tracked escaped prefix when this keystroke continues it, or an empty
    /// prefix when the caret sits on an empty line; `None` otherwise.
    pub(super) fn speculative_continuation(
        &self,
        range: DisplayRange,
        action: crate::InputAction,
    ) -> Option<(usize, String)> {
        if action != crate::InputAction::Typing
            || range.start != range.end
            || self.composition.is_some()
        {
            return None;
        }
        let line = self.projection.block_lines(range).into_iter().next()?;
        let (_, at) = self.projection.source_bounds(range.start.0);
        if line.content.end != at {
            return None;
        }
        if line.content.start == at {
            return Some((at, String::new()));
        }
        let (start, prefix) = self.speculative.as_ref()?;
        (line.content.start == *start
            && at == start + prefix.len()
            && self.source.byte_slice(*start..at).to_string() == *prefix)
            .then(|| (*start, prefix.clone()))
    }

    /// A line-start escape the engine itself wrote while this line was typed
    /// (`&#35;` for a lone `#`, `&#45;` for `-`, ...) is only needed while the
    /// line would otherwise read as another block. When the next typed
    /// character makes the line plain, the escaped prefix and the character are
    /// replaced together with literal text; the parser must read the same
    /// block kinds and the same display as before. Escapes already in the note
    /// are never touched: the prefix is tracked from an empty line end.
    pub(super) fn speculative_prefix_rewrite(
        &self,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
    ) -> Option<(DisplayRange, String)> {
        let (start, prefix) = self.speculative.as_ref()?;
        let first = inserted.chars().next()?;
        if action != crate::InputAction::Typing
            || range.start != range.end
            || self.composition.is_some()
            || first.is_whitespace()
            || inserted.contains(['\r', '\n'])
            || !inserted.is_ascii()
        {
            return None;
        }
        let line = self.projection.block_lines(range).into_iter().next()?;
        let (_, at) = self.projection.source_bounds(range.start.0);
        if line.code
            || line.metadata
            || line.html
            || line.heading != 0
            || line.content.start != *start
            || line.content.end != at
            || at != start + prefix.len()
            || self.source.byte_slice(*start..at).to_string() != *prefix
        {
            return None;
        }
        let decoded = decode_numeric_entities(prefix)?;
        // Leading whitespace is escaped so other readers keep it; never undo that.
        if decoded == *prefix
            || range.start.0 < decoded.len()
            || decoded.chars().any(char::is_whitespace)
        {
            return None;
        }
        let literal = format!("{decoded}{inserted}");
        let display = self.projection.display.to_string();
        let from = range.start.0 - decoded.len();
        if !display.is_char_boundary(from) || display[from..range.start.0] != decoded {
            return None;
        }
        let source = self.source.to_string();
        let trial = format!("{}{literal}{}", &source[..*start], &source[at..]);
        let reread = EditorSession::open(&trial);
        let expected = format!("{}{literal}{}", &display[..from], &display[range.start.0..]);
        if reread.display_text() != expected || self.block_signature() != reread.block_signature() {
            return None;
        }
        Some((
            DisplayRange {
                start: DisplayOffset(from),
                end: range.start,
            },
            literal,
        ))
    }

    pub(super) fn block_signature(&self) -> Vec<(u8, usize, bool, bool, bool, bool, bool, bool)> {
        let whole = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(self.projection.display.len_bytes()),
        };
        self.projection
            .block_lines(whole)
            .iter()
            .map(|line| {
                (
                    line.heading,
                    line.quote_depth,
                    line.divider,
                    line.code,
                    line.html,
                    line.metadata,
                    line.list.is_some(),
                    line.task.is_some(),
                )
            })
            .collect()
    }

    /// Remembers the typed prefix of the caret's line while the caret is at the
    /// line's end and the line grew from empty by typing, so the next keystroke can
    /// drop them once they are no longer needed.
    pub(super) fn track_speculative_prefix(&mut self, continued: Option<&(usize, String)>) {
        self.speculative = None;
        let range = self.selection;
        if range.start != range.end {
            return;
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return;
        };
        let (_, at) = self.projection.source_bounds(range.start.0);
        if line.code
            || line.metadata
            || line.html
            || line.content.end != at
            || at < line.content.start
        {
            return;
        }
        let prefix = self.source.byte_slice(line.content.start..at).to_string();
        if prefix.len() > 32 {
            return;
        }
        // The prefix is the engine's only if it grew from the empty line or
        // from the previously tracked prefix.
        match continued {
            Some((start, previous))
                if *start == line.content.start
                    && decode_numeric_entities(&prefix).is_some_and(|now| {
                        decode_numeric_entities(previous)
                            .is_some_and(|before| now.starts_with(&before))
                    }) => {}
            _ => return,
        }
        self.speculative = Some((line.content.start, prefix));
    }
}

/// Decodes a run of `&#N;` references and literal ASCII characters; `None` for
/// anything else (named or hex entities, non-ASCII results).
fn decode_numeric_entities(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(ch) = rest.chars().next() {
        if let Some(tail) = rest.strip_prefix("&#") {
            let end = tail.find(';')?;
            let code: u32 = tail[..end].parse().ok()?;
            let decoded = char::from_u32(code).filter(char::is_ascii)?;
            out.push(decoded);
            rest = &tail[end + 1..];
        } else if ch.is_ascii() {
            out.push(ch);
            rest = &rest[1..];
        } else {
            return None;
        }
    }
    Some(out)
}
