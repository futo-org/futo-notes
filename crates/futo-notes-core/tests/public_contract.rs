use std::fs;

use futo_notes_core::files::{safe_note_path, sanitize_title, write_atomic_text};
use futo_notes_core::hash::hash_sha256;

#[test]
fn atomic_write_preserves_exact_hashable_text() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let contents = [
        "",
        "hello",
        "café ☕ 日本語 مرحبا",
        "line1\nline2\r\nline3\rline4",
        "\u{FEFF}BOM content",
        "null\0byte",
    ];

    for (index, content) in contents.into_iter().enumerate() {
        let path = root.join(format!("test-{index}.md"));
        write_atomic_text(&path, content).unwrap();
        let stored = fs::read_to_string(path).unwrap();
        assert_eq!(stored, content);
        assert_eq!(hash_sha256(&stored), hash_sha256(content));
    }
}

#[test]
fn durable_note_round_trip_preserves_title_path_content_and_hash() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let long_title = "a".repeat(100);
    let titles = [
        "Normal Note",
        "café ☕ 日本語",
        "📝 Emoji Title 🎵",
        "note<with>forbidden:chars",
        "   padded   ",
        "...",
        "Mixed 🎵 and <forbidden>",
        "مرحبا بالعالم",
        long_title.as_str(),
    ];

    for (index, title) in titles.into_iter().enumerate() {
        let sanitized = sanitize_title(title);
        let id = format!("case-{index}/{sanitized}");
        let path = safe_note_path(root, &id).unwrap();
        let content = format!("# {sanitized}\n\nContent for {title}");

        write_atomic_text(&path, &content).unwrap();

        let stored = fs::read_to_string(&path).unwrap();
        assert_eq!(stored, content);
        assert_eq!(hash_sha256(&stored), hash_sha256(&content));
        assert_eq!(
            path.file_stem().and_then(|stem| stem.to_str()),
            Some(sanitized.as_str())
        );
    }
}
