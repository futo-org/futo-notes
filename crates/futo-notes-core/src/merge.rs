#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeResult {
    Clean(String),
    Conflict,
}

pub fn three_way_merge(base: &str, server: &str, client: &str) -> MergeResult {
    match diffy::merge(base, server, client) {
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
        let ours = "hello\nworld\n";
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
        let theirs = "hello\nworld\n";

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
        let ours = "line 2\nline 3\nline 4\nline 5\n";
        let theirs = "line 1\nline 2\nline 3\nline 4\n";

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
        ours_lines[4] = "EDITED BY SERVER".to_string();

        let mut theirs_lines = base_lines.clone();
        theirs_lines[94] = "EDITED BY CLIENT".to_string();

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

    #[test]
    fn qa_scenario4_paragraph_merge_no_trailing_newline() {
        let base = "qa threeway merge test\n\nParagraph one: unchanged by both clients.\n\nParagraph two: client will edit this paragraph.\n\nParagraph three: peer will edit this paragraph.";
        let ours = "qa threeway merge test\n\nParagraph one: unchanged by both clients.\n\nParagraph two: client will edit this paragraph.\n\nParagraph three: PEER EDITED THIS PARAGRAPH during three-way merge test.";
        let theirs = "qa threeway merge test\n\nParagraph one: unchanged by both clients.\n\nParagraph two: CLIENT EDITED THIS PARAGRAPH during three-way merge test.\n\nParagraph three: peer will edit this paragraph.";

        let result = three_way_merge(base, ours, theirs);
        match &result {
            MergeResult::Clean(merged) => {
                assert!(merged.contains("CLIENT EDITED"), "Missing client edit");
                assert!(merged.contains("PEER EDITED"), "Missing peer edit");
            }
            MergeResult::Conflict => {
                panic!("Expected clean merge for non-overlapping paragraph edits, got conflict")
            }
        }
    }
}

// Property-based tests. The examples above pin known merge shapes; these pin the
// invariants a note merge must hold for EVERY input, because a merge that loses
// a side's edit destroys user data silently.
#[cfg(test)]
mod property_tests {
    use std::collections::HashSet;

    use proptest::prelude::*;

    use super::*;

    const DISJOINT_BASE_LINES: usize = 12;

    /// Multi-line note text over a tiny alphabet, so two independently
    /// generated sides actually share lines instead of always being disjoint
    /// noise. The optional trailing newline covers the "\ No newline at end of
    /// file" shape real notes hit.
    fn note_text() -> impl Strategy<Value = String> {
        (prop::collection::vec("[a-c]{0,3}", 0..8), any::<bool>()).prop_map(
            |(lines, trailing_newline)| {
                let joined = lines.join("\n");
                if trailing_newline {
                    format!("{joined}\n")
                } else {
                    joined
                }
            },
        )
    }

    fn numbered_lines() -> String {
        (0..DISJOINT_BASE_LINES)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    fn replace_line(text: &str, index: usize, replacement: &str) -> String {
        let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
        lines[index] = replacement.to_owned();
        lines.join("\n") + "\n"
    }

    proptest! {
        #[test]
        fn merging_the_same_inputs_twice_gives_the_same_result(
            base in note_text(),
            server in note_text(),
            client in note_text(),
        ) {
            prop_assert_eq!(
                three_way_merge(&base, &server, &client),
                three_way_merge(&base, &server, &client),
            );
        }

        #[test]
        fn an_unchanged_server_side_yields_the_client_text(
            base in note_text(),
            client in note_text(),
        ) {
            prop_assert_eq!(
                three_way_merge(&base, &base, &client),
                MergeResult::Clean(client),
            );
        }

        #[test]
        fn an_unchanged_client_side_yields_the_server_text(
            base in note_text(),
            server in note_text(),
        ) {
            prop_assert_eq!(
                three_way_merge(&base, &server, &base),
                MergeResult::Clean(server),
            );
        }

        #[test]
        fn identical_sides_yield_that_side(
            base in note_text(),
            edited in note_text(),
        ) {
            prop_assert_eq!(
                three_way_merge(&base, &edited, &edited),
                MergeResult::Clean(edited),
            );
        }

        /// A clean merge may drop a line only if a side deleted it; it must
        /// never introduce a line neither side has (conflict markers included).
        #[test]
        fn a_clean_merge_invents_no_line(
            base in note_text(),
            server in note_text(),
            client in note_text(),
        ) {
            if let MergeResult::Clean(merged) = three_way_merge(&base, &server, &client) {
                let side_lines: HashSet<&str> = server.lines().chain(client.lines()).collect();
                for line in merged.lines() {
                    prop_assert!(
                        side_lines.contains(line),
                        "merge invented line {:?} (server {:?}, client {:?})",
                        line,
                        server,
                        client,
                    );
                }
            }
        }

        /// Edits far apart in the same note must both survive: this is the
        /// concurrent-edit case sync relies on, and the one where losing a side
        /// silently discards a user's typing.
        #[test]
        fn edits_to_distant_lines_keep_both_sides_content(
            server_index in 0usize..4,
            client_index in 8usize..DISJOINT_BASE_LINES,
        ) {
            let base = numbered_lines();
            let server = replace_line(&base, server_index, "EDITED BY SERVER");
            let client = replace_line(&base, client_index, "EDITED BY CLIENT");

            let merged = match three_way_merge(&base, &server, &client) {
                MergeResult::Clean(merged) => merged,
                MergeResult::Conflict => {
                    return Err(TestCaseError::fail(format!(
                        "distant edits at {server_index}/{client_index} conflicted"
                    )))
                }
            };

            let merged_lines: HashSet<&str> = merged.lines().collect();
            prop_assert!(merged_lines.contains("EDITED BY SERVER"));
            prop_assert!(merged_lines.contains("EDITED BY CLIENT"));
            for (index, line) in base.lines().enumerate() {
                if index != server_index && index != client_index {
                    prop_assert!(merged_lines.contains(line), "lost untouched line {line:?}");
                }
            }
        }
    }
}
