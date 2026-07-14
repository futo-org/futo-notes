//! Pure note rules. Nothing in this module reads or writes the vault.

use futo_notes_core::files::sanitize_title;

pub const WELCOME_NOTE_ID: &str = "Welcome";

pub const WELCOME_NOTE: &str = "\
# Welcome to FUTO Notes

FUTO Notes keeps everything as plain Markdown files on your device. There's no \
account to create and nothing to sign in to — your notes are just files you own.

## Getting started
- Open a note to edit it; changes save as you type.

## Markdown you can use
- **Bold**, *italic*, and `inline code`
- Bulleted and numbered lists
- [ ] Checklists — tap a box to toggle it
- Group notes with #tags, or sort them into folders

Feel free to delete this note once you've had a look around.
";

pub fn split_id(id: &str) -> (String, String) {
    id.rsplit_once('/')
        .map(|(folder, title)| (folder.to_owned(), title.to_owned()))
        .unwrap_or_else(|| (String::new(), id.to_owned()))
}

pub fn sanitize_folder_path(raw: &str) -> String {
    raw.split('/')
        .filter(|component| !component.is_empty())
        .map(sanitize_title)
        .collect::<Vec<_>>()
        .join("/")
}

pub fn make_id(folder: &str, title: &str) -> String {
    let folder = sanitize_folder_path(folder);
    let title = sanitize_title(title);
    if folder.is_empty() {
        title
    } else {
        format!("{folder}/{title}")
    }
}

pub fn note_tags(content: &str) -> Vec<String> {
    crate::tags::extract_tag_names(content)
}

/// The list preview contract is: collapse CRLF/LF/tab to spaces, trim the
/// whole result, then keep at most 100 Unicode scalar values.
pub fn make_preview(content: &str) -> String {
    let mut collapsed = String::with_capacity(content.len().min(128));
    let mut chars = content.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                collapsed.push(' ');
            }
            '\n' | '\t' => collapsed.push(' '),
            other => collapsed.push(other),
        }
    }
    collapsed.trim().chars().take(100).collect()
}

pub fn make_rich_preview(content: &str) -> String {
    let mut lines = Vec::with_capacity(3);
    for raw in content.lines() {
        if lines.len() == 3 {
            break;
        }
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with("```")
            || line.starts_with("~~~")
            || is_table_or_rule(line)
        {
            continue;
        }
        let line = display_line(line);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines.join("\n").chars().take(280).collect()
}

fn is_table_or_rule(line: &str) -> bool {
    line.starts_with('|')
        || (line.contains('-') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
}

fn display_line(line: &str) -> String {
    let mut line = line.trim_start();
    while let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start();
    }

    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if (1..=6).contains(&hashes) {
        let rest = &line[hashes..];
        if rest.is_empty() || rest.starts_with(' ') {
            line = rest.trim_start();
        }
    }

    let bytes = line.as_bytes();
    if bytes.len() >= 5
        && matches!(bytes[0], b'-' | b'*' | b'+')
        && bytes[1] == b' '
        && bytes[2] == b'['
        && bytes[4] == b']'
    {
        let marker = match bytes[3] {
            b'x' | b'X' => Some("☑"),
            b' ' => Some("☐"),
            _ => None,
        };
        if let Some(marker) = marker {
            return format!("{marker} {}", line[5..].trim_start());
        }
    }
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'*' | b'+') && bytes[1] == b' ' {
        return format!("• {}", line[2..].trim_start());
    }
    line.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_keep_the_filename_leaf_verbatim_after_sanitizing() {
        assert_eq!(
            make_id("Specs//Drafts ", "Roadmap 1.4.1"),
            "Specs/Drafts/Roadmap 1.4.1"
        );
        assert_eq!(
            split_id("Specs/Drafts/Roadmap 1.4.1"),
            ("Specs/Drafts".into(), "Roadmap 1.4.1".into())
        );
    }

    #[test]
    fn preview_follows_collapse_trim_then_unicode_limit() {
        assert_eq!(make_preview(" \r\n hello\tworld \n"), "hello world");
        assert_eq!(make_preview(&"🎉".repeat(101)).chars().count(), 100);
    }

    #[test]
    fn rich_preview_turns_block_markdown_into_list_text() {
        assert_eq!(
            make_rich_preview("# Heading\n- [ ] todo\n> - item\n| hidden |"),
            "Heading\n☐ todo\n• item"
        );
    }
}
