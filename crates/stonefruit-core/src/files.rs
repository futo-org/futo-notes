use filetime::{set_file_mtime, FileTime};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ── Constants ───────────────────────────────────────────────────────────

/// Maximum title length (characters, before .md extension).
pub const MAX_TITLE_LENGTH: usize = 200;

/// Fallback title when input is empty or all-invalid.
pub const FALLBACK_TITLE: &str = "Untitled";

// ── Types ───────────────────────────────────────────────────────────────

/// Mirrors TypeScript `FilenameIssueKind` from `packages/shared/src/filename.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilenameIssueKind {
    ForbiddenChars,
    LeadingDots,
    TrailingDots,
    TooLong,
    Empty,
}

/// A single validation issue found in a title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilenameIssue {
    pub kind: FilenameIssueKind,
    pub message: String,
}

// ── Forbidden character check ───────────────────────────────────────────

/// Returns true if `c` is forbidden in a note title/filename.
/// Matches the TypeScript `FORBIDDEN_CHARS_RE`: `< > : " / \ | ? *` plus
/// all control characters (0x00–0x1F and 0x7F).
fn is_forbidden_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
}

/// Returns true if the string contains any forbidden characters.
fn contains_forbidden(s: &str) -> bool {
    s.chars().any(is_forbidden_char)
}

// ── Title sanitization (matches TS sanitizeTitle) ───────────────────────

/// Canonical title sanitization. Strips filesystem-breaking characters and
/// surrounding whitespace. Does not rewrite dots or silently truncate.
pub fn sanitize_title(title: &str) -> String {
    let result: String = title.chars().filter(|c| !is_forbidden_char(*c)).collect();
    let trimmed = result.trim();
    // If all-dots after stripping, treat as empty
    if trimmed.chars().all(|c| c == '.') && !trimmed.is_empty() {
        return FALLBACK_TITLE.to_string();
    }
    if trimmed.is_empty() {
        return FALLBACK_TITLE.to_string();
    }
    trimmed.to_string()
}

/// Validate a title and return a list of specific issues found.
/// Does NOT modify the title — use `sanitize_title()` for that.
pub fn validate_title(title: &str) -> Vec<FilenameIssue> {
    let mut issues = Vec::new();

    if title.trim().is_empty() {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::Empty,
            message: "Title cannot be empty".to_string(),
        });
        return issues;
    }

    if contains_forbidden(title) {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::ForbiddenChars,
            message: "That character can't be used in a note title".to_string(),
        });
    }

    if title.starts_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::LeadingDots,
            message: "Title cannot start with a dot".to_string(),
        });
    }

    if title.ends_with('.') {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TrailingDots,
            message: "Title cannot end with a dot".to_string(),
        });
    }

    if title.len() > MAX_TITLE_LENGTH {
        issues.push(FilenameIssue {
            kind: FilenameIssueKind::TooLong,
            message: format!("Title cannot exceed {MAX_TITLE_LENGTH} characters"),
        });
    }

    issues
}

/// Convenience: returns true if the title has no validation issues.
pub fn is_valid_title(title: &str) -> bool {
    validate_title(title).is_empty()
}

// ── Path safety (from core.rs) ──────────────────────────────────────────

/// Validate a note ID: rejects empty, path traversal (`..`, `.`, `/`, `\`),
/// and forbidden filesystem characters (`< > : " | ? *`, control chars).
pub fn ensure_safe_note_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("note id cannot be empty".to_string());
    }
    if id.contains('/') || id.contains('\\') || id == ".." || id == "." {
        return Err("invalid note id".to_string());
    }
    if contains_forbidden(id) {
        return Err("invalid note id".to_string());
    }
    Ok(())
}

/// Build the full `.md` path for a note ID, after safety validation.
pub fn safe_note_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    ensure_safe_note_id(id)?;
    Ok(base.join(format!("{id}.md")))
}

/// Build a path under `base` from a relative path, rejecting traversal.
pub fn safe_appdata_path(base: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    for component in rel.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path traversal blocked".to_string())
            }
            _ => {}
        }
    }
    Ok(base.join(rel))
}

// ── File I/O helpers ────────────────────────────────────────────────────

/// Current time in milliseconds since Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Use `modified_at` if provided (> 0), otherwise fall back to current time.
/// A value of 0 means "not provided" (the `#[serde(default)]` sentinel).
pub fn mtime_or_now(modified_at: i64) -> i64 {
    if modified_at > 0 {
        modified_at
    } else {
        now_ms()
    }
}

/// Extract mtime from file metadata as milliseconds since epoch.
pub fn file_mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

/// Set the mtime of a file to the given millisecond timestamp.
pub fn set_file_mtime_ms(path: &Path, modified_at_ms: i64) -> Result<(), String> {
    let filetime = FileTime::from_unix_time(
        modified_at_ms / 1000,
        ((modified_at_ms % 1000) * 1_000_000) as u32,
    );
    set_file_mtime(path, filetime).map_err(|e| e.to_string())
}

/// Atomically write text to a file (write to temp, then rename).
pub fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    // Use a short temp name to avoid exceeding filesystem limits (ext4: 255 bytes).
    // The old pattern `.{filename}.tmp-{ts}` could overflow for long filenames.
    let tmp = parent.join(format!(".sf-tmp-{}", now_ms()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Extract a note ID from a filename by stripping the `.md` extension.
/// Returns `None` for non-`.md` files or if the resulting ID is empty.
pub fn note_id_from_filename(name: &str) -> Option<String> {
    let id = name.strip_suffix(".md")?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Find a unique note ID by appending `-2`, `-3`, ... if needed.
/// If `wanted` matches `exclude`, it is returned directly (used for renames).
pub fn get_unique_note_id(
    base: &Path,
    wanted: &str,
    exclude: Option<&str>,
) -> Result<String, String> {
    if Some(wanted) == exclude {
        return Ok(wanted.to_string());
    }

    let wanted_path = safe_note_path(base, wanted)?;
    if !wanted_path.exists() {
        return Ok(wanted.to_string());
    }

    let mut counter = 2;
    loop {
        let candidate = format!("{wanted}-{counter}");
        if Some(candidate.as_str()) == exclude {
            return Ok(candidate);
        }
        let candidate_path = safe_note_path(base, &candidate)?;
        if !candidate_path.exists() {
            return Ok(candidate);
        }
        counter += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("stonefruit-core-files-test-{}-{n}", now_ms()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    // ── ensure_safe_note_id ─────────────────────────────────────────

    #[test]
    fn safe_id_rejects_empty() {
        assert!(ensure_safe_note_id("").is_err());
    }

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(ensure_safe_note_id("..").is_err());
        assert!(ensure_safe_note_id(".").is_err());
        assert!(ensure_safe_note_id("foo/bar").is_err());
        assert!(ensure_safe_note_id("foo\\bar").is_err());
    }

    #[test]
    fn safe_id_rejects_forbidden_chars() {
        assert!(ensure_safe_note_id("note<1>").is_err());
        assert!(ensure_safe_note_id("note:colon").is_err());
        assert!(ensure_safe_note_id("note\"quote").is_err());
        assert!(ensure_safe_note_id("note|pipe").is_err());
        assert!(ensure_safe_note_id("note?question").is_err());
        assert!(ensure_safe_note_id("note*star").is_err());
        // Control character
        assert!(ensure_safe_note_id("note\x00null").is_err());
        assert!(ensure_safe_note_id("note\x1ftab").is_err());
        assert!(ensure_safe_note_id("note\x7fdel").is_err());
    }

    #[test]
    fn safe_id_accepts_valid() {
        assert!(ensure_safe_note_id("hello world").is_ok());
        assert!(ensure_safe_note_id("café").is_ok());
        assert!(ensure_safe_note_id("my-note").is_ok());
        assert!(ensure_safe_note_id(".hidden").is_ok());
    }

    // ── safe_appdata_path ───────────────────────────────────────────

    #[test]
    fn appdata_path_rejects_traversal() {
        let base = Path::new("/tmp/test");
        assert!(safe_appdata_path(base, "..").is_err());
        assert!(safe_appdata_path(base, "../etc/passwd").is_err());
        assert!(safe_appdata_path(base, "/etc/passwd").is_err());
    }

    #[test]
    fn appdata_path_accepts_valid() {
        let base = Path::new("/tmp/test");
        assert!(safe_appdata_path(base, ".preferences.json").is_ok());
        assert!(safe_appdata_path(base, "subdir/file.json").is_ok());
        let result = safe_appdata_path(base, ".preferences.json").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/test/.preferences.json"));
    }

    // ── write_atomic_text ───────────────────────────────────────────

    #[test]
    fn atomic_write_creates_file() {
        let base = temp_dir();
        let path = base.join("test-note.md");
        write_atomic_text(&path, "hello world").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello world");
        // No leftover .tmp files
        let tmps: Vec<_> = fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(tmps.is_empty());
        cleanup(&base);
    }

    #[test]
    fn atomic_write_overwrites() {
        let base = temp_dir();
        let path = base.join("overwrite.md");
        write_atomic_text(&path, "first").unwrap();
        write_atomic_text(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        cleanup(&base);
    }

    // ── note_id_from_filename ───────────────────────────────────────

    #[test]
    fn note_id_valid() {
        assert_eq!(note_id_from_filename("hello.md"), Some("hello".to_string()));
        assert_eq!(
            note_id_from_filename("my note.md"),
            Some("my note".to_string())
        );
    }

    #[test]
    fn note_id_non_md() {
        assert_eq!(note_id_from_filename("hello.txt"), None);
    }

    #[test]
    fn note_id_empty() {
        assert_eq!(note_id_from_filename(".md"), None);
    }

    // ── get_unique_note_id ──────────────────────────────────────────

    #[test]
    fn unique_id_no_collision() {
        let base = temp_dir();
        let id = get_unique_note_id(&base, "new-note", None).unwrap();
        assert_eq!(id, "new-note");
        cleanup(&base);
    }

    #[test]
    fn unique_id_collision_increments() {
        let base = temp_dir();
        write_atomic_text(&base.join("taken.md"), "x").unwrap();
        let id = get_unique_note_id(&base, "taken", None).unwrap();
        assert_eq!(id, "taken-2");
        cleanup(&base);
    }

    #[test]
    fn unique_id_exclude_self() {
        let base = temp_dir();
        write_atomic_text(&base.join("note.md"), "x").unwrap();
        // When exclude == wanted, return wanted directly (rename case)
        let id = get_unique_note_id(&base, "note", Some("note")).unwrap();
        assert_eq!(id, "note");
        cleanup(&base);
    }

    // ── sanitize_title ──────────────────────────────────────────────

    #[test]
    fn sanitize_strips_forbidden() {
        assert_eq!(sanitize_title("hello<world>"), "helloworld");
        assert_eq!(sanitize_title("a:b|c*d"), "abcd");
    }

    #[test]
    fn sanitize_trims_whitespace() {
        assert_eq!(sanitize_title("  hello  "), "hello");
    }

    #[test]
    fn sanitize_fallback_on_empty() {
        assert_eq!(sanitize_title(""), FALLBACK_TITLE);
        assert_eq!(sanitize_title("   "), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_fallback_on_all_dots() {
        assert_eq!(sanitize_title("..."), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        assert_eq!(sanitize_title("My grocery list"), "My grocery list");
        assert_eq!(sanitize_title("café notes"), "café notes");
    }

    // ── validate_title ──────────────────────────────────────────────

    #[test]
    fn validate_empty() {
        let issues = validate_title("");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, FilenameIssueKind::Empty);
    }

    #[test]
    fn validate_forbidden_chars() {
        let issues = validate_title("note<1>");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_leading_dots() {
        let issues = validate_title(".hidden");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
    }

    #[test]
    fn validate_trailing_dots() {
        let issues = validate_title("file.");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::TrailingDots));
    }

    #[test]
    fn validate_too_long() {
        let long_title = "a".repeat(MAX_TITLE_LENGTH + 1);
        let issues = validate_title(&long_title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
    }

    #[test]
    fn validate_clean_title() {
        assert!(validate_title("My grocery list").is_empty());
        assert!(is_valid_title("My grocery list"));
    }

    // ── Cross-validation: sanitize output accepted by ensure_safe ───

    #[test]
    fn sanitized_output_passes_safe_id() {
        let inputs = [
            "hello<world>",
            "a:b|c*d",
            "note\x00null",
            "café ☕",
            "   spaces   ",
            "...",
        ];
        for input in &inputs {
            let sanitized = sanitize_title(input);
            // sanitize_title should never produce something that ensure_safe_note_id rejects
            // (except for leading dots which is a validation concern, not a safety concern)
            if !sanitized.starts_with('.') {
                assert!(
                    ensure_safe_note_id(&sanitized).is_ok(),
                    "sanitize_title({input:?}) produced {sanitized:?} which is rejected by ensure_safe_note_id"
                );
            }
        }
    }

    // ── file_mtime_ms / set_file_mtime_ms ───────────────────────────

    #[test]
    fn mtime_round_trip() {
        let base = temp_dir();
        let path = base.join("mtime-test.md");
        write_atomic_text(&path, "content").unwrap();

        let target_ms: i64 = 1_700_000_000_000;
        set_file_mtime_ms(&path, target_ms).unwrap();

        let meta = fs::metadata(&path).unwrap();
        let read_ms = file_mtime_ms(&meta);
        // Allow 1-second tolerance for filesystem granularity
        assert!(
            (read_ms - target_ms).abs() < 1000,
            "mtime mismatch: {read_ms} vs {target_ms}"
        );

        cleanup(&base);
    }

    // ── Adversarial: Unicode filenames ──────────────────────────────────

    #[test]
    fn sanitize_emoji_title() {
        let result = sanitize_title("📝 My Notes 🎵");
        assert_eq!(result, "📝 My Notes 🎵");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_cjk_characters() {
        let result = sanitize_title("日本語ノート");
        assert_eq!(result, "日本語ノート");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_rtl_text() {
        let result = sanitize_title("مرحبا بالعالم");
        assert_eq!(result, "مرحبا بالعالم");
        assert!(ensure_safe_note_id(&result).is_ok());
    }

    #[test]
    fn sanitize_zero_width_joiners() {
        // Family emoji: person + ZWJ + person + ZWJ + child
        let title = "Family 👨\u{200D}👩\u{200D}👧 notes";
        let result = sanitize_title(title);
        assert!(!result.is_empty());
        assert_ne!(result, FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_scripts() {
        let result = sanitize_title("Hello مرحبا 你好 🌍");
        assert_eq!(result, "Hello مرحبا 你好 🌍");
    }

    // ── Adversarial: Title length boundaries ────────────────────────────

    #[test]
    fn validate_title_exactly_max_length() {
        let title = "a".repeat(MAX_TITLE_LENGTH);
        assert!(
            validate_title(&title).is_empty(),
            "exactly MAX_TITLE_LENGTH should be valid"
        );
    }

    #[test]
    fn validate_title_one_over_max() {
        let title = "a".repeat(MAX_TITLE_LENGTH + 1);
        let issues = validate_title(&title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
    }

    #[test]
    fn validate_title_one_under_max() {
        let title = "a".repeat(MAX_TITLE_LENGTH - 1);
        assert!(validate_title(&title).is_empty());
    }

    #[test]
    fn sanitize_very_long_title_250_chars() {
        // sanitize_title does NOT truncate — it only strips forbidden chars
        let title = "a".repeat(250);
        let result = sanitize_title(&title);
        assert_eq!(result.len(), 250, "sanitize should not truncate");
    }

    // ── Adversarial: Titles that are only special chars ─────────────────

    #[test]
    fn sanitize_only_whitespace() {
        assert_eq!(sanitize_title("   "), FALLBACK_TITLE);
        assert_eq!(sanitize_title("\t\t"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("\n\n"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_only_dots() {
        assert_eq!(sanitize_title("."), FALLBACK_TITLE);
        assert_eq!(sanitize_title(".."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("..."), FALLBACK_TITLE);
        assert_eq!(sanitize_title("......................"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_only_forbidden_chars() {
        assert_eq!(sanitize_title("<>:\"/\\|?*"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("***"), FALLBACK_TITLE);
        assert_eq!(sanitize_title("???"), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_valid_invalid() {
        assert_eq!(sanitize_title("he<ll>o"), "hello");
        assert_eq!(sanitize_title("a*b*c"), "abc");
        assert_eq!(sanitize_title("note: important"), "note important");
    }

    #[test]
    fn sanitize_control_characters_only() {
        // All control chars (0x00-0x1F, 0x7F) should be stripped
        let title = "\x00\x01\x02\x1f\x7f";
        assert_eq!(sanitize_title(title), FALLBACK_TITLE);
    }

    #[test]
    fn sanitize_mixed_control_and_text() {
        assert_eq!(sanitize_title("hel\x00lo"), "hello");
        assert_eq!(sanitize_title("\x01good\x02"), "good");
    }

    // ── Adversarial: sanitize→ensure_safe consistency ───────────────────

    #[test]
    fn sanitize_output_always_passes_ensure_safe_wide_range() {
        let long_title = "a".repeat(300);
        let adversarial_inputs = [
            "",
            "   ",
            "...",
            ".",
            "..",
            "<>:\"/\\|?*",
            "\x00\x01\x02",
            "hello<world>",
            "a:b|c*d",
            "note\x00null",
            "café ☕",
            "📝🎵🎶",
            "日本語",
            "مرحبا",
            "hello\x7fworld",
            "   ...   ",
            "***only stars***",
            "normal title",
            long_title.as_str(),
            ".hidden",
            "trailing.",
            "..leading",
        ];
        for input in &adversarial_inputs {
            let sanitized = sanitize_title(input);
            assert!(!sanitized.is_empty(), "sanitize({input:?}) returned empty");
            // sanitize should always produce something ensure_safe accepts
            // (dots are a validation concern, but ensure_safe should still accept them)
            let result = ensure_safe_note_id(&sanitized);
            assert!(
                result.is_ok(),
                "sanitize_title({input:?}) = {sanitized:?} rejected by ensure_safe_note_id: {:?}",
                result.err()
            );
        }
    }

    // ── Adversarial: Path traversal attacks ─────────────────────────────

    #[test]
    fn safe_id_rejects_path_traversal_variants() {
        let attacks = [
            "..",
            ".",
            "foo/bar",
            "foo\\bar",
            "../etc/passwd",
            "..\\windows\\system32",
            "foo/../bar",
            "foo/./bar",
        ];
        for attack in &attacks {
            assert!(
                ensure_safe_note_id(attack).is_err(),
                "ensure_safe_note_id should reject {attack:?}"
            );
        }
    }

    #[test]
    fn safe_id_rejects_null_bytes() {
        assert!(ensure_safe_note_id("note\x00").is_err());
        assert!(ensure_safe_note_id("\x00note").is_err());
        assert!(ensure_safe_note_id("no\x00te").is_err());
    }

    #[test]
    fn safe_appdata_rejects_traversal_variants() {
        let base = Path::new("/tmp/notes");
        let attacks = [
            "..",
            "../etc/passwd",
            "../../etc/shadow",
            "/etc/passwd",
            "foo/../../../etc/passwd",
        ];
        for attack in &attacks {
            assert!(
                safe_appdata_path(base, attack).is_err(),
                "safe_appdata_path should reject {attack:?}"
            );
        }
    }

    #[test]
    fn safe_appdata_rejects_windows_absolute() {
        let base = Path::new("/tmp/notes");
        // On Unix these parse differently, but the / and \ checks should still catch them
        assert!(safe_appdata_path(base, "/absolute/path").is_err());
    }

    #[test]
    fn safe_id_accepts_dots_in_middle() {
        // "v2.0" is a valid note ID — dots are only special as the entire name
        assert!(ensure_safe_note_id("v2.0").is_ok());
        assert!(ensure_safe_note_id("my.note.title").is_ok());
    }

    #[test]
    fn safe_id_accepts_hidden_files() {
        // .hidden is accepted by ensure_safe (validation is separate)
        assert!(ensure_safe_note_id(".hidden").is_ok());
    }

    #[test]
    fn safe_id_rejects_trailing_spaces_with_forbidden() {
        // Trailing spaces themselves aren't forbidden, but control chars are
        assert!(ensure_safe_note_id("note\x00").is_err());
    }

    // ── Adversarial: get_unique_note_id with many collisions ────────────

    #[test]
    fn unique_id_100_collisions() {
        let base = temp_dir();
        // Create 100 files: taken.md, taken-2.md, ..., taken-100.md
        write_atomic_text(&base.join("taken.md"), "x").unwrap();
        for i in 2..=100 {
            write_atomic_text(&base.join(format!("taken-{i}.md")), "x").unwrap();
        }
        let id = get_unique_note_id(&base, "taken", None).unwrap();
        assert_eq!(id, "taken-101");
        cleanup(&base);
    }

    #[test]
    fn unique_id_exclude_matches_candidate() {
        let base = temp_dir();
        write_atomic_text(&base.join("note.md"), "x").unwrap();
        write_atomic_text(&base.join("note-2.md"), "x").unwrap();
        // Exclude "note-2" — should return "note-2" directly since it matches exclude
        let id = get_unique_note_id(&base, "note", Some("note-2")).unwrap();
        assert_eq!(id, "note-2");
        cleanup(&base);
    }

    // ── Adversarial: write_atomic_text edge cases ───────────────────────

    #[test]
    fn atomic_write_nested_nonexistent_dirs() {
        let base = temp_dir();
        let path = base.join("a").join("b").join("c").join("deep-note.md");
        write_atomic_text(&path, "deep content").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "deep content");
        cleanup(&base);
    }

    #[test]
    fn atomic_write_null_bytes_in_content() {
        let base = temp_dir();
        let path = base.join("null-bytes.md");
        let content = "hello\x00world\x00end";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_very_long_lines() {
        let base = temp_dir();
        let path = base.join("long-line.md");
        let content = "x".repeat(100_000);
        write_atomic_text(&path, &content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_mixed_line_endings() {
        let base = temp_dir();
        let path = base.join("mixed-endings.md");
        let content = "line1\nline2\r\nline3\rline4";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    #[test]
    fn atomic_write_empty_content() {
        let base = temp_dir();
        let path = base.join("empty.md");
        write_atomic_text(&path, "").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        cleanup(&base);
    }

    #[test]
    fn atomic_write_unicode_content() {
        let base = temp_dir();
        let path = base.join("unicode.md");
        let content = "café ☕ 日本語 مرحبا 📝 \u{FEFF}BOM";
        write_atomic_text(&path, content).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        cleanup(&base);
    }

    // ── Adversarial: note_id_from_filename edge cases ───────────────────

    #[test]
    fn note_id_from_double_md_extension() {
        // "note.md.md" — strip_suffix removes only the single trailing ".md"
        assert_eq!(
            note_id_from_filename("note.md.md"),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn note_id_from_just_md() {
        // ".md" — id would be empty
        assert_eq!(note_id_from_filename(".md"), None);
    }

    #[test]
    fn note_id_from_md_in_middle() {
        // "my.md.notes.txt" — not .md extension
        assert_eq!(note_id_from_filename("my.md.notes.txt"), None);
    }

    #[test]
    fn note_id_unicode_filename() {
        assert_eq!(
            note_id_from_filename("日本語.md"),
            Some("日本語".to_string())
        );
        assert_eq!(
            note_id_from_filename("📝notes.md"),
            Some("📝notes".to_string())
        );
    }

    #[test]
    fn note_id_case_sensitivity() {
        // ".MD" is not ".md"
        assert_eq!(note_id_from_filename("note.MD"), None);
        assert_eq!(note_id_from_filename("note.Md"), None);
    }

    // ── Adversarial: validate_title edge cases ──────────────────────────

    #[test]
    fn validate_whitespace_only() {
        let issues = validate_title("   ");
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::Empty));
    }

    #[test]
    fn validate_tab_only() {
        let issues = validate_title("\t\t");
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::Empty));
    }

    #[test]
    fn validate_multiple_issues() {
        // ".note<1>" — leading dot + forbidden chars
        let issues = validate_title(".note<1>");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_leading_and_trailing_dots() {
        let issues = validate_title(".both.");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::LeadingDots));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::TrailingDots));
    }

    #[test]
    fn validate_long_with_forbidden() {
        let title = format!("{}<", "a".repeat(MAX_TITLE_LENGTH));
        let issues = validate_title(&title);
        assert!(issues.iter().any(|i| i.kind == FilenameIssueKind::TooLong));
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }

    #[test]
    fn validate_title_with_newlines() {
        // Newlines are control characters — should flag as forbidden
        let issues = validate_title("line1\nline2");
        assert!(issues
            .iter()
            .any(|i| i.kind == FilenameIssueKind::ForbiddenChars));
    }
}
