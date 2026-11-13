//! The table types hosts read and send. The core reads and edits tables
//! (`crate::engine::commands::tables`); views never see pipes or the delimiter
//! row: they receive cells and ask for commands.
mod types;
pub use types::*;

/// Plain text pasted into one cell: edge blank lines go, and every other run
/// of whitespace that holds a line break becomes one space. Edge spaces and
/// tabs that do not touch a break are the pasted text.
pub(crate) fn flatten_for_cell(text: &str) -> String {
    let mut rest = text;
    loop {
        let blank = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        match rest[blank..].strip_prefix("\r\n").or_else(|| {
            rest[blank..]
                .strip_prefix('\n')
                .or_else(|| rest[blank..].strip_prefix('\r'))
        }) {
            Some(after) => rest = after,
            None => break,
        }
    }
    loop {
        let trimmed = rest.trim_end_matches([' ', '\t']);
        match trimmed.strip_suffix("\r\n").or_else(|| {
            trimmed
                .strip_suffix('\n')
                .or_else(|| trimmed.strip_suffix('\r'))
        }) {
            Some(before) => rest = before,
            None => break,
        }
    }
    let mut result = String::with_capacity(rest.len());
    let mut run = String::new();
    for ch in rest.chars() {
        if ch.is_whitespace() {
            run.push(ch);
            continue;
        }
        flush_run(&mut result, &mut run);
        result.push(ch);
    }
    flush_run(&mut result, &mut run);
    result
}

fn flush_run(result: &mut String, run: &mut String) {
    if run.contains(['\n', '\r']) {
        result.push(' ');
    } else {
        result.push_str(run);
    }
    run.clear();
}
