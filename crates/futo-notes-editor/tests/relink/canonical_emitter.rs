//! Public canonical rewrite facts consumed by the editor.

use futo_notes_wikilinks::{observe_wikilink_rewrite, RewriteRange};

#[test]
fn observed_ranges_follow_actual_unicode_copy_and_whole_replacement_emission() {
    let input = "前 [[Old]] + [[Other]] + [[Old]]";
    let ids = vec!["Old".into(), "Other".into()];
    let observed = observe_wikilink_rewrite(input, "Old", "Long name", &ids);
    let expected = "前 [[Long name]] + [[Other]] + [[Long name]]";
    assert_eq!((observed.source.as_str(), observed.rewrites), (expected, 2));
    assert_eq!(observed.input_len, 33);
    assert_eq!(
        observed.copied,
        vec![
            RewriteRange {
                before: 0..4,
                after: 0..4
            },
            RewriteRange {
                before: 11..26,
                after: 17..32
            }
        ]
    );
    assert_eq!(
        observed.replaced,
        vec![
            RewriteRange {
                before: 4..11,
                after: 4..17
            },
            RewriteRange {
                before: 26..33,
                after: 32..45
            }
        ]
    );
    assert_eq!(
        futo_notes_wikilinks::rewrite_wikilinks(input, "Old", "Long name", &ids),
        (expected.into(), 2)
    );
}

#[test]
fn observed_no_change_and_equal_emission_preserve_canonical_count_semantics() {
    let ids = vec!["Old".into()];
    for text in ["", "plain tail", "[[Other]] tail"] {
        let observed = observe_wikilink_rewrite(text, "Old", "New", &ids);
        assert_eq!((observed.source.as_str(), observed.rewrites), (text, 0));
        assert!(observed.replaced.is_empty());
        let copies = if text.is_empty() {
            vec![]
        } else {
            vec![RewriteRange {
                before: 0..text.len(),
                after: 0..text.len(),
            }]
        };
        assert_eq!(observed.copied, copies);
    }
    let observed = observe_wikilink_rewrite("[[Old]]", "Old", "Old", &ids);
    assert_eq!(
        (observed.source.as_str(), observed.rewrites),
        ("[[Old]]", 1)
    );
    assert!(observed.copied.is_empty());
    assert_eq!(
        observed.replaced,
        vec![RewriteRange {
            before: 0..7,
            after: 0..7
        }]
    );
}
