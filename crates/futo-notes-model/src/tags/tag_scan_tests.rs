use super::code_regions::{inline_code_regions, scan_fence_lines};
use super::*;
use std::time::Instant;

fn names(s: &str) -> Vec<String> {
    tag_regex_matches(s)
}

#[test]
fn matches_basic_and_adjacent() {
    assert_eq!(names("#hello"), vec!["hello"]);
    // start-of-string and after-whitespace; adjacency must both match (the
    // boundaries are zero-width, so the shared space isn't consumed).
    assert_eq!(names("#a #b"), vec!["a", "b"]);
    // start-of-line via (?m)^ (subsumed by "preceded by \n").
    assert_eq!(names("x\n#tag"), vec!["tag"]);
    // not preceded by whitespace ⇒ no match.
    assert!(names("word#tag").is_empty());
    assert!(names("##tag").is_empty());
}

#[test]
fn terminators_and_punctuation() {
    // Right-boundary terminators. Each `#` has a valid LEFT boundary (a
    // leading space) so we isolate the terminator behavior.
    for (input, want) in [
        ("#tag.", "tag"),
        ("#tag,", "tag"),
        (" #tag)", "tag"),
        ("#tag!", "tag"),
        ("#tag?", "tag"),
        ("#tag]", "tag"),
        ("#tag}", "tag"),
    ] {
        assert_eq!(names(input), vec![want], "input={input:?}");
    }
    // The `#` must follow whitespace or line-start: `(#tag)` has `#` after
    // `(`, so per `(?:^|(?<=\s))` it does NOT match (matches the TS rule).
    assert!(names("(#tag)").is_empty());
    // a non-terminator, non-name char right after the name ⇒ no match
    // (the look-ahead fails and no shorter name is valid).
    assert!(names("#tag@x").is_empty());
    assert!(names("#tag/x").is_empty());
    // hyphen/underscore/digits are name chars.
    assert_eq!(names("#a-b_c1 "), vec!["a-b_c1"]);
}

#[test]
fn length_cap_50() {
    let n50: String = format!("#{}", "a".repeat(50));
    assert_eq!(names(&n50), vec!["a".repeat(50)]);
    // 51 name chars: greedy matches 50, char #51 is a name char (not a
    // terminator) ⇒ look-ahead fails for every length ⇒ no match.
    let n51: String = format!("#{} ", "a".repeat(51));
    assert!(names(&n51).is_empty(), "51-char run must not match");
}

#[test]
fn first_char_must_be_letter() {
    assert!(names("#1tag").is_empty());
    assert!(names("#-tag").is_empty());
    assert!(names("#_tag").is_empty());
}

#[test]
fn unicode_whitespace_boundary() {
    // U+00A0 NBSP is Unicode White_Space, so it satisfies both (?<=\s)
    // (left) and the look-ahead (right).
    assert_eq!(names("a\u{00a0}#tag\u{00a0}b"), vec!["tag"]);
}

// Regression for the catastrophic-backtracking hang: a ~1 MB note must
// extract in well under a second. The old fancy-regex `captures_iter`
// pegged a core for MINUTES on the real ~900 KB note, which left the
// off-main iOS note scan permanently incomplete (list stuck empty).
#[test]
fn large_note_extracts_fast_and_correct() {
    // Markdown-ish block: headers, prose with `#`, punctuation, and one
    // real tag — the kind of content that triggered the blow-up.
    let block = "### A Heading With Words\n\nSome prose, with punctuation; \
        and the #realtag here. More text: see section #3 and item #b? Yes.\n\n";
    let big = block.repeat(10_000); // ~1.2 MB (larger than the real culprit)
    assert!(big.len() > 1_000_000);

    let t = Instant::now();
    let tags = extract_tags(&big);
    let elapsed = t.elapsed();

    assert!(
        tags.contains(&"#realtag".to_string()),
        "should still find the real tag"
    );
    // `#3` (digit-led) and `#b?` are valid/invalid per the rules; the point
    // is it COMPLETES. Linear scan ⇒ a few ms; the old code ⇒ minutes.
    assert!(
        elapsed.as_secs() < 3,
        "tag extraction on a ~1 MB note must be fast (was {elapsed:?}); \
         a regression here means catastrophic backtracking is back"
    );
}

// Regression for the second catastrophic-backtracking path: stripping
// inline code from a large mixed-markdown note. The obstacle-course
// monster contains thousands of backtick runs; the backreference-based
// fancy-regex implementation never returned once the note reached ~1 MB.
#[test]
fn large_backtick_note_extracts_fast_and_correct() {
    let prose = "Ordinary prose with enough varied words and #outside content \
        to model a real long note rather than a blank buffer.\n\n"
        .repeat(20_000);
    let big = format!("{prose}```rust\nlet hidden = \"#inside\";\n```\n");
    assert!(big.len() > 1_000_000);

    let t = Instant::now();
    let tags = extract_tags(&big);
    let elapsed = t.elapsed();

    assert_eq!(tags, vec!["#outside"]);
    assert!(
        elapsed.as_secs() < 3,
        "code-region stripping on a ~1 MB backtick note must be fast \
         (was {elapsed:?})"
    );
}

#[test]
fn fence_scan_matches_the_fence_regex() {
    let fence = Regex::new(r"(?m)^( {0,3})(`{3,}|~{3,})(.*)$").unwrap();
    let alphabet = ['`', '~', ' ', '\n', 'a'];
    for len in 0usize..=7 {
        for mut encoded in 0..alphabet.len().pow(len as u32) {
            let mut input = String::with_capacity(len);
            for _ in 0..len {
                input.push(alphabet[encoded % alphabet.len()]);
                encoded /= alphabet.len();
            }
            let expected: Vec<_> = fence
                .captures_iter(&input)
                .flatten()
                .map(|caps| {
                    let whole = caps.get(0).unwrap();
                    (
                        whole.start(),
                        whole.end(),
                        caps[2].as_bytes()[0],
                        caps[2].len(),
                        caps[3].trim().is_empty(),
                    )
                })
                .collect();
            let actual: Vec<_> = scan_fence_lines(&input, input.as_bytes())
                .iter()
                .map(|line| {
                    (
                        line.index,
                        line.end_of_line,
                        line.marker_char,
                        line.marker_len,
                        line.rest_blank,
                    )
                })
                .collect();
            assert_eq!(actual, expected, "input={input:?}");
        }
    }
}

#[test]
fn linear_inline_scan_matches_backreference_regex() {
    let old = Regex::new(r"(`+)([^`]*?)\1").unwrap();
    let alphabet = ['`', 'a', '\n', 'é'];

    for len in 0usize..=8 {
        let cases = alphabet.len().pow(len as u32);
        for mut encoded in 0..cases {
            let mut input = String::with_capacity(len);
            for _ in 0..len {
                input.push(alphabet[encoded % alphabet.len()]);
                encoded /= alphabet.len();
            }

            let expected: Vec<(usize, usize)> = old
                .find_iter(&input)
                .flatten()
                .map(|matched| (matched.start(), matched.end()))
                .collect();
            assert_eq!(
                inline_code_regions(input.as_bytes(), &[]),
                expected,
                "input={input:?}"
            );
        }
    }
}
