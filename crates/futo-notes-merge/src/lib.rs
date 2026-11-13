//! Portable three-way source merge, shared by sync, store and editor history.
use std::collections::HashMap;
use std::fmt::Write;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeResult {
    Clean(String),
    Conflict,
}

pub fn three_way_merge(base: &str, server: &str, client: &str) -> MergeResult {
    match diffy::merge(base, server, client) {
        Ok(merged) => MergeResult::Clean(merged),
        Err(_) => merge_words(base, server, client),
    }
}

/// Reuse diffy's conservative overlap decisions at Unicode word boundaries.
/// Interned tokens are whole lines so whitespace, CRLF, combining sequences and
/// literal conflict-marker text stay opaque and round-trip without normalization.
/// A word is indivisible: competing spellings must not become a hybrid word.
fn merge_words(base: &str, server: &str, client: &str) -> MergeResult {
    if removes_repeated_token(base, server) || removes_repeated_token(base, client) {
        return MergeResult::Conflict;
    }
    let mut ids = HashMap::new();
    let mut tokens = Vec::new();
    let mut encode = |source: &str| {
        let mut encoded = String::new();
        for token in tokenize(source) {
            let next = tokens.len();
            let id = *ids.entry(token.to_owned()).or_insert_with(|| {
                tokens.push(token.to_owned());
                next
            });
            writeln!(encoded, "{id}").expect("writing to a String cannot fail");
        }
        encoded
    };
    let base = encode(base);
    let server = encode(server);
    let client = encode(client);
    let forward = merge_encoded(&base, &server, &client, &tokens);
    // Repeated tokens let diffy pick one of several equally good alignments,
    // which can hide that two edits touch the same occurrence. Merging the
    // mirrored sequence breaks those ties the other way; the merge stands only
    // when both alignments agree, otherwise the callers preserve both versions.
    let mirrored = merge_encoded(
        &reverse_lines(&base),
        &reverse_lines(&server),
        &reverse_lines(&client),
        &tokens,
    );
    match (forward, mirrored) {
        (Some(forward), Some(mut mirrored)) => {
            mirrored.reverse();
            if forward == mirrored {
                MergeResult::Clean(forward.concat())
            } else {
                MergeResult::Conflict
            }
        }
        _ => MergeResult::Conflict,
    }
}

/// Word tokens, except that links, URLs and code spans stay whole: two edits
/// inside one such construct would otherwise splice a target nobody wrote.
/// Detection is lexical and per source; an unterminated opener is plain text.
fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or(text)
}

fn tokenize(source: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let (mut plain, mut at) = (0, 0);
    while at < source.len() {
        let rest = &source[at..];
        let atom = if rest.starts_with("[[") {
            first_line(rest).find("]]").map(|end| end + 2)
        } else if rest.starts_with("](") {
            first_line(rest).find(')').map(|end| end + 1)
        } else if rest.starts_with('`') {
            // A span closes at the next backtick run of exactly the opening length.
            let run = rest.bytes().take_while(|&byte| byte == b'`').count();
            let mut found = None;
            let mut offset = run;
            while let Some(position) = first_line(&rest[offset..]).find('`') {
                let start = offset + position;
                let length = rest[start..]
                    .bytes()
                    .take_while(|&byte| byte == b'`')
                    .count();
                if length == run {
                    found = Some(start + length);
                    break;
                }
                offset = start + length;
            }
            // An unclosed run is plain text.
            found
        } else if (rest.starts_with("http://") || rest.starts_with("https://"))
            && !source[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
        {
            // The whole whitespace-delimited candidate: parentheses can be part of a URL.
            Some(rest.find(char::is_whitespace).unwrap_or(rest.len()))
        } else {
            None
        };
        match atom {
            Some(length) => {
                tokens.extend(source[plain..at].split_word_bounds());
                tokens.push(&source[at..at + length]);
                at += length;
                plain = at;
            }
            None => at += rest.chars().next().map_or(1, char::len_utf8),
        }
    }
    tokens.extend(source[plain..].split_word_bounds());
    tokens
}

/// A side that deletes or replaces one occurrence of a token the base repeats
/// could mean any of those occurrences, and no token alignment can say which.
/// Both sides then may be editing the same one, so the merge must not guess.
fn removes_repeated_token(base: &str, side: &str) -> bool {
    let count = |source: &str| {
        let mut counts = HashMap::new();
        for token in source
            .split_word_bounds()
            .filter(|token| !token.trim().is_empty())
        {
            *counts.entry(token.to_owned()).or_insert(0usize) += 1;
        }
        counts
    };
    let (base, side) = (count(base), count(side));
    base.iter()
        .any(|(token, &before)| before > 1 && side.get(token).copied().unwrap_or(0) < before)
}

fn reverse_lines(encoded: &str) -> String {
    encoded.lines().rev().fold(String::new(), |mut out, line| {
        out.push_str(line);
        out.push('\n');
        out
    })
}

fn merge_encoded<'a>(
    base: &str,
    server: &str,
    client: &str,
    tokens: &'a [String],
) -> Option<Vec<&'a str>> {
    diffy::merge(base, server, client).ok().map(|merged| {
        merged
            .lines()
            .map(|id| tokens[id.parse::<usize>().expect("interned token id")].as_str())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_words_merge_without_reserializing_untouched_source() {
        assert_eq!(
            three_way_merge(
                "  first middle last\t\r\n",
                "  REMOTE middle last\t\r\n",
                "  first middle LOCAL\t\r\n"
            ),
            MergeResult::Clean("  REMOTE middle LOCAL\t\r\n".into()),
        );
    }

    #[test]
    fn competing_spellings_of_one_word_do_not_create_a_hybrid() {
        assert_eq!(
            three_way_merge("the cat rests", "the bat rests", "the car rests"),
            MergeResult::Conflict
        );
    }

    #[test]
    fn repeated_tokens_do_not_hide_same_position_insertion_ambiguity() {
        for base in ["word word word", "猫 猫 猫", "\u{85} word\u{205f}word\r\n"] {
            let remote = format!("REMOTE {base}");
            let local = format!("LOCAL {base}");
            assert_eq!(
                three_way_merge(base, &remote, &local),
                MergeResult::Conflict
            );
            assert_eq!(
                three_way_merge(base, &local, &remote),
                MergeResult::Conflict
            );
        }
    }

    #[test]
    fn repeated_tokens_do_not_hide_delete_edit_overlap() {
        // The remote deletion of one `a ` could be the first (overlapping the
        // local replacement) or the last repeat; the alignment is ambiguous.
        for (base, deleted, replaced) in [
            ("a a a", "a a", "b a a"),
            ("猫 猫 猫", "猫 猫", "犬 猫 猫"),
            ("a a a\r\n", "a a\r\n", "a a b\r\n"),
            ("a a a a", "SERVER a a", "a a LOCAL a"),
        ] {
            assert_eq!(
                three_way_merge(base, deleted, replaced),
                MergeResult::Conflict,
                "{base:?}"
            );
            assert_eq!(
                three_way_merge(base, replaced, deleted),
                MergeResult::Conflict,
                "{base:?} swapped"
            );
        }
    }

    #[test]
    fn independent_edits_inside_one_atomic_construct_conflict() {
        for (base, remote, local) in [
            ("[[Project Plan]]", "[[Project Draft]]", "[[Roadmap Plan]]"),
            (
                "see [site](https://a.com/x) now",
                "see [site](https://b.com/x) now",
                "see [site](https://a.com/y) now",
            ),
            (
                "go https://a.com/x now",
                "go https://b.com/x now",
                "go https://a.com/y now",
            ),
            (
                "run `git status now`",
                "run `git branch now`",
                "run `git status later`",
            ),
            (
                "![alt](img one.png)",
                "![alt](img two.png)",
                "![alt](pic one.png)",
            ),
        ] {
            assert_eq!(
                three_way_merge(base, remote, local),
                MergeResult::Conflict,
                "{base:?}"
            );
            assert_eq!(
                three_way_merge(base, local, remote),
                MergeResult::Conflict,
                "{base:?} swapped"
            );
        }
    }

    #[test]
    fn an_atomic_construct_edit_still_merges_with_a_separate_word() {
        assert_eq!(
            three_way_merge(
                "first [[Project Plan]] last",
                "FIRST [[Project Plan]] last",
                "first [[Project Plan]] LAST",
            ),
            MergeResult::Clean("FIRST [[Project Plan]] LAST".into())
        );
        assert_eq!(
            three_way_merge(
                "first [[Project Plan]] last",
                "first [[Roadmap]] last",
                "first [[Project Plan]] LAST",
            ),
            MergeResult::Clean("first [[Roadmap]] LAST".into())
        );
    }

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
    fn a_removed_final_line_ending_merges_with_an_edit_elsewhere() {
        // One side deletes the note's final empty line, the other edits the top.
        assert_eq!(
            three_way_merge("a\nb\n", "a\nb", "A\nb\n"),
            MergeResult::Clean("A\nb".to_string())
        );
        assert_eq!(
            three_way_merge("a\nb", "a\nb\n", "A\nb"),
            MergeResult::Clean("A\nb\n".to_string())
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

        /// Output may compose a new line, but cannot invent a word or separator.
        #[test]
        fn a_clean_merge_invents_no_token(
            base in note_text(),
            server in note_text(),
            client in note_text(),
        ) {
            if let MergeResult::Clean(merged) = three_way_merge(&base, &server, &client) {
                let side_tokens: HashSet<&str> = server.split_word_bounds().chain(client.split_word_bounds()).collect();
                for token in merged.split_word_bounds() {
                    prop_assert!(side_tokens.contains(token), "invented token {token:?}");
                }
            }
        }

        /// Word-level merges can compose a line neither side has on its own.
        /// They still must not prefer one side based on argument ordering.
        #[test]
        fn swapping_sides_does_not_choose_a_different_merge(
            base in note_text(),
            server in note_text(),
            client in note_text(),
        ) {
            prop_assert_eq!(
                three_way_merge(&base, &server, &client),
                three_way_merge(&base, &client, &server),
            );
        }

        #[test]
        fn independent_words_keep_both_contributions_and_exact_surroundings(
            before in "[a-z]{1,12}",
            after in "[a-z]{1,12}",
            whitespace in prop::sample::select(vec![" ", "\t", "\u{205f}"]),
        ) {
            let base = format!("α{whitespace}first{whitespace}middle{whitespace}last{whitespace}e\u{301}\r\n");
            let remote = base.replacen("first", &before, 1);
            let local = base.replacen("last", &after, 1);
            let expected = format!("α{whitespace}{before}{whitespace}middle{whitespace}{after}{whitespace}e\u{301}\r\n");
            prop_assert_eq!(three_way_merge(&base, &remote, &local), MergeResult::Clean(expected));
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
