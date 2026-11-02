use super::range;
use futo_notes_editor::{
    Affinity, CorrespondenceKind, DisplayOffset, EditorSession, Revision, SourceOffset,
};

/// Runs are lossless: a literal run is byte-identical source, every interior
/// offset maps as the session maps it, and a long literal stretch arrives as
/// one run rather than one piece per byte.
#[test]
fn correspondence_runs_map_like_the_session() {
    let source = "---\ntitle: x\n---\n# Head **b** &acE; &amp; [l](u) `c`\r\n\n\
        - [ ] item *i*\n  > quote ~~s~~\n\n***\n\n```rs\nfn x() {}\n```\n\
        ![alt](img.png) [[Wiki]] plain 日😀 tail\n";
    let session = EditorSession::open(source);
    let text = session.display_text();
    let slice = session.project(Revision(0), range(0, text.len())).unwrap();
    let kinds = |kind| {
        slice
            .correspondence
            .iter()
            .filter(|p| p.kind == kind)
            .count()
    };
    assert!(kinds(CorrespondenceKind::Hidden) > 0 && kinds(CorrespondenceKind::Replaced) > 0);
    let (mut source_end, mut display_end) = (0, 0);
    for (index, part) in slice.correspondence.iter().enumerate() {
        let (source_range, display_range) = (
            part.source.start.0..part.source.end.0,
            part.display.start.0..part.display.end.0,
        );
        assert_eq!(
            (source_range.start, display_range.start),
            (source_end, display_end)
        );
        (source_end, display_end) = (source_range.end, display_range.end);
        match part.kind {
            CorrespondenceKind::Literal => {
                assert_eq!(&source[source_range.clone()], &text[display_range.clone()])
            }
            CorrespondenceKind::Hidden => assert!(display_range.is_empty()),
            CorrespondenceKind::Replaced => assert!(!display_range.is_empty()),
        }
        if let Some(next) = slice.correspondence.get(index + 1) {
            assert!(next.kind != part.kind || part.kind == CorrespondenceKind::Replaced);
        }
        for at in display_range
            .clone()
            .skip(1)
            .filter(|&at| text.is_char_boundary(at))
        {
            let bounds = part.source_bounds(DisplayOffset(at)).unwrap();
            for (affinity, expected) in [
                (Affinity::Backward, bounds.start),
                (Affinity::Forward, bounds.end),
            ] {
                let actual = session.source_at(Revision(0), DisplayOffset(at), affinity);
                assert_eq!(actual.unwrap(), expected, "display {at} {affinity:?}");
            }
            if part.kind == CorrespondenceKind::Literal {
                assert_eq!(part.display_at(bounds.start), Some(DisplayOffset(at)));
            }
        }
        assert_eq!(part.display_at(part.source.end), Some(part.display.end));
    }
    assert_eq!((source_end, display_end), (source.len(), text.len()));
    let replaced = slice
        .correspondence
        .iter()
        .find(|p| p.kind == CorrespondenceKind::Replaced);
    let replaced = replaced.unwrap();
    assert_eq!(
        replaced.display_at(SourceOffset(replaced.source.start.0 + 1)),
        None
    );

    let long = "word ".repeat(2_000);
    let session = EditorSession::open(&long);
    let slice = session.project(Revision(0), range(0, long.len())).unwrap();
    assert_eq!(slice.correspondence.len(), 1);
}
