/// Three-way merge for concurrent note edits.
///
/// Uses the last-synced content as the common ancestor (base) to merge
/// non-overlapping edits from two sides. Falls back to conflict copy
/// when edits overlap.
/// Result of a three-way merge attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeResult {
    /// Clean merge — all changes applied without conflict.
    Clean(String),
    /// Overlapping edits — fall back to conflict copy.
    Conflict,
}

/// Attempt a three-way merge of `ours` and `theirs` against a common `base`.
///
/// - If edits are in non-overlapping regions, returns `MergeResult::Clean(merged)`.
/// - If edits overlap, returns `MergeResult::Conflict`.
///
/// Convention: `ours` = server version, `theirs` = client version.
pub fn three_way_merge(base: &str, ours: &str, theirs: &str) -> MergeResult {
    match diffy::merge(base, ours, theirs) {
        Ok(merged) => MergeResult::Clean(merged),
        Err(_) => MergeResult::Conflict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_overlapping_edits_merge_cleanly() {
        let base = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let ours = "LINE ONE\nline 2\nline 3\nline 4\nline 5\n";
        let theirs = "line 1\nline 2\nline 3\nline 4\nLINE FIVE\n";

        let result = three_way_merge(base, ours, theirs);
        assert_eq!(
            result,
            MergeResult::Clean("LINE ONE\nline 2\nline 3\nline 4\nLINE FIVE\n".to_string())
        );
    }

    #[test]
    fn overlapping_edits_produce_conflict() {
        let base = "line 1\nline 2\nline 3\n";
        let ours = "line 1\nOUR EDIT\nline 3\n";
        let theirs = "line 1\nTHEIR EDIT\nline 3\n";

        assert_eq!(three_way_merge(base, ours, theirs), MergeResult::Conflict);
    }

    #[test]
    fn one_side_unchanged_takes_other() {
        let base = "hello\nworld\n";
        let ours = "hello\nworld\n"; // unchanged
        let theirs = "hello\nuniverse\n";

        assert_eq!(
            three_way_merge(base, ours, theirs),
            MergeResult::Clean("hello\nuniverse\n".to_string())
        );
    }

    #[test]
    fn other_side_unchanged_takes_changed() {
        let base = "hello\nworld\n";
        let ours = "hello\nearth\n";
        let theirs = "hello\nworld\n"; // unchanged

        assert_eq!(
            three_way_merge(base, ours, theirs),
            MergeResult::Clean("hello\nearth\n".to_string())
        );
    }

    #[test]
    fn both_sides_identical_changes_merge_cleanly() {
        let base = "line 1\nline 2\n";
        let ours = "line 1\nSAME EDIT\n";
        let theirs = "line 1\nSAME EDIT\n";

        assert_eq!(
            three_way_merge(base, ours, theirs),
            MergeResult::Clean("line 1\nSAME EDIT\n".to_string())
        );
    }

    #[test]
    fn empty_base_both_add_different_content_conflicts() {
        let base = "";
        let ours = "server added this\n";
        let theirs = "client added this\n";

        assert_eq!(three_way_merge(base, ours, theirs), MergeResult::Conflict);
    }

    #[test]
    fn empty_base_both_add_same_content_merges() {
        let base = "";
        let ours = "same content\n";
        let theirs = "same content\n";

        assert_eq!(
            three_way_merge(base, ours, theirs),
            MergeResult::Clean("same content\n".to_string())
        );
    }

    #[test]
    fn additions_at_different_positions() {
        let base = "line 1\nline 2\nline 3\n";
        let ours = "new top\nline 1\nline 2\nline 3\n";
        let theirs = "line 1\nline 2\nline 3\nnew bottom\n";

        let result = three_way_merge(base, ours, theirs);
        assert_eq!(
            result,
            MergeResult::Clean("new top\nline 1\nline 2\nline 3\nnew bottom\n".to_string())
        );
    }

    #[test]
    fn deletions_at_different_positions() {
        let base = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let ours = "line 2\nline 3\nline 4\nline 5\n"; // deleted line 1
        let theirs = "line 1\nline 2\nline 3\nline 4\n"; // deleted line 5

        let result = three_way_merge(base, ours, theirs);
        assert_eq!(
            result,
            MergeResult::Clean("line 2\nline 3\nline 4\n".to_string())
        );
    }

    #[test]
    fn large_file_small_edits_different_regions() {
        let mut base_lines: Vec<String> = (1..=100).map(|i| format!("line {i}")).collect();
        let base = base_lines.join("\n") + "\n";

        let mut ours_lines = base_lines.clone();
        ours_lines[4] = "EDITED BY SERVER".to_string(); // line 5

        let mut theirs_lines = base_lines.clone();
        theirs_lines[94] = "EDITED BY CLIENT".to_string(); // line 95

        let ours = ours_lines.join("\n") + "\n";
        let theirs = theirs_lines.join("\n") + "\n";

        base_lines[4] = "EDITED BY SERVER".to_string();
        base_lines[94] = "EDITED BY CLIENT".to_string();
        let expected = base_lines.join("\n") + "\n";

        assert_eq!(
            three_way_merge(&base, &ours, &theirs),
            MergeResult::Clean(expected)
        );
    }

    #[test]
    fn all_three_identical_returns_clean() {
        let content = "same\ncontent\n";
        assert_eq!(
            three_way_merge(content, content, content),
            MergeResult::Clean(content.to_string())
        );
    }
}
