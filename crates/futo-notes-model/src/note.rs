//! Pure note rules. Nothing in this module reads or writes the vault.

use std::borrow::Cow;

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

/// Stands in for an embedded image in every list preview. Two code points
/// (U+1F5BC framed picture + U+FE0F variation selector), so it spends two of
/// the preview budget and renders as an emoji rather than a text glyph.
pub const IMAGE_PLACEHOLDER: &str = "🖼️";

/// Replace every `![alt](target)` image construct with [`IMAGE_PLACEHOLDER`].
///
/// Previews are read as text, so raw image markdown is noise: a note whose
/// first line is an image previewed as `![](image-20260814-130425.png)`.
/// Borrowed unchanged when the content has no image construct, which is the
/// common case on the list hot path.
///
/// Mirrored in TypeScript by `packages/editor/src/preview.ts`
/// (`IMAGE_MARKDOWN_PATTERN`), whose `/!\[[^\]]*\]\([^)]*\)/g` this scanner
/// reproduces exactly: a non-`]` alt run, then a non-`)` target run. A
/// construct missing either terminator is left alone, and `[link](url)`
/// without the leading `!` is not an image.
fn replace_images(content: &str) -> Cow<'_, str> {
    let bytes = content.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut cursor = 0;
    while cursor + 1 < bytes.len() {
        if bytes[cursor] != b'!' || bytes[cursor + 1] != b'[' {
            cursor += 1;
            continue;
        }
        match image_construct_end(bytes, cursor) {
            Some(end) => {
                if out.is_empty() {
                    out.reserve(content.len());
                }
                out.push_str(&content[copied..cursor]);
                out.push_str(IMAGE_PLACEHOLDER);
                copied = end;
                cursor = end;
            }
            None => cursor += 1,
        }
    }
    if copied == 0 {
        return Cow::Borrowed(content);
    }
    out.push_str(&content[copied..]);
    Cow::Owned(out)
}

/// Exclusive end of the `![...](...)` construct starting at `start`, or `None`
/// when the text there only looks like one. Every delimiter is ASCII, so the
/// byte offsets returned are always char boundaries.
fn image_construct_end(bytes: &[u8], start: usize) -> Option<usize> {
    let alt_start = start + 2;
    let alt_end = alt_start + bytes[alt_start..].iter().position(|b| *b == b']')?;
    if bytes.get(alt_end + 1) != Some(&b'(') {
        return None;
    }
    let target_start = alt_end + 2;
    let target_end = target_start + bytes[target_start..].iter().position(|b| *b == b')')?;
    Some(target_end + 1)
}

/// The list preview contract is: stand every image construct in as
/// [`IMAGE_PLACEHOLDER`], collapse CRLF/LF/tab to spaces, trim the whole
/// result, then keep at most 100 Unicode scalar values.
pub fn make_preview(content: &str) -> String {
    collapse_to_preview(&replace_images(content))
}

fn collapse_to_preview(content: &str) -> String {
    let mut preview = String::with_capacity(content.len().min(128));
    let mut pending_whitespace = String::new();
    let mut pending_whitespace_chars = 0;
    let mut preview_chars = 0;
    let mut chars = content.chars().peekable();
    while let Some(character) = chars.next() {
        let collapsed = match character {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                ' '
            }
            '\n' | '\t' => ' ',
            other => other,
        };

        if collapsed.is_whitespace() {
            if !preview.is_empty() && pending_whitespace_chars < 100 - preview_chars {
                pending_whitespace.push(collapsed);
                pending_whitespace_chars += 1;
            }
            continue;
        }

        for whitespace in pending_whitespace.drain(..) {
            if preview_chars == 100 {
                return preview;
            }
            preview.push(whitespace);
            preview_chars += 1;
        }
        pending_whitespace_chars = 0;
        if preview_chars == 100 {
            return preview;
        }
        preview.push(collapsed);
        preview_chars += 1;
        if preview_chars == 100 {
            return preview;
        }
    }
    preview
}

pub fn make_rich_preview(content: &str) -> String {
    let content = replace_images(content);
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

    fn allocation_heavy_preview(content: &str) -> String {
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
    fn streaming_preview_matches_the_previous_rule_exhaustively() {
        let alphabet = ['a', ' ', '\t', '\n', '\r', '\u{2003}', '🎉'];
        for length in 0..=6 {
            let combinations = alphabet.len().pow(length);
            for mut value in 0..combinations {
                let mut input = String::new();
                for _ in 0..length {
                    input.push(alphabet[value % alphabet.len()]);
                    value /= alphabet.len();
                }
                assert_eq!(
                    make_preview(&input),
                    allocation_heavy_preview(&input),
                    "input: {input:?}"
                );
            }
        }

        let long = format!("{}   later", "x".repeat(99));
        assert_eq!(make_preview(&long), allocation_heavy_preview(&long));

        let whitespace_tail = format!("kept{}", "\u{2003}".repeat(1_000_000));
        assert_eq!(
            make_preview(&whitespace_tail),
            allocation_heavy_preview(&whitespace_tail)
        );
    }

    #[test]
    fn preview_stands_an_image_construct_in_as_a_placeholder() {
        assert_eq!(make_preview("![](image-20260814-130425.png)"), "🖼️");
        assert_eq!(make_preview("![](a.png)\ntext"), "🖼️ text");
        assert_eq!(
            make_preview("before ![alt](a.png) after"),
            "before 🖼️ after"
        );
        // Only the image construct: a plain link and an unterminated `![` stay put.
        assert_eq!(
            make_preview("a [link](https://example.com) stays"),
            "a [link](https://example.com) stays"
        );
        assert_eq!(
            make_preview("![unterminated](a.png"),
            "![unterminated](a.png"
        );
        assert_eq!(make_preview("![no target] here"), "![no target] here");
    }

    #[test]
    fn rich_preview_stands_an_image_construct_in_as_a_placeholder() {
        assert_eq!(
            make_rich_preview("![](image-20260814-130425.png)\nMeeting notes"),
            "🖼️\nMeeting notes"
        );
        assert_eq!(make_rich_preview("- ![](a.png) caption"), "• 🖼️ caption");
        assert_eq!(make_rich_preview("# ![](a.png)"), "🖼️");
    }

    #[test]
    fn rich_preview_turns_block_markdown_into_list_text() {
        assert_eq!(
            make_rich_preview("# Heading\n- [ ] todo\n> - item\n| hidden |"),
            "Heading\n☐ todo\n• item"
        );
    }
}
