//! Physical-end provenance must remain independent of visible neighbors.
use super::*;

#[test]
fn exact_edge_provenance_survives_nested_windows_but_never_derived_ancestry() {
    let prefix = "- parent\n  ```\n  opaque\n";
    for tail in ["", "- outside", "<!-- -->\n", "  continuation\n"] {
        let full = format!("{prefix}{tail}");
        let real = EditorSession::open(&full);
        let exact = real.stage_source(prefix, 0..prefix.len());
        let nested = exact.stage_source(prefix, 0..prefix.len());
        for session in [&exact, &nested] {
            match session.physical_tail() {
                PhysicalTail::Eof => assert!(tail.is_empty()),
                PhysicalTail::Row {
                    code,
                    first_item,
                    empty_comment,
                    item_depth,
                    ..
                } => {
                    assert!(!tail.is_empty());
                    assert_eq!(empty_comment, tail == "<!-- -->\n");
                    if empty_comment {
                        assert_eq!(
                            session.context.fence_edge.map(|f| (
                                f.depth,
                                f.list_quote,
                                f.code_quote,
                                f.gap_bytes
                            )),
                            Some((1, 0, 0, 0))
                        );
                    }
                    if tail == "- outside" {
                        assert!(!code);
                        assert_eq!(first_item, Some(true));
                        assert_eq!(item_depth, Some(1));
                        assert_eq!(
                            session.context.fence_edge.map(|f| (
                                f.depth,
                                f.list_quote,
                                f.code_quote,
                                f.gap_bytes
                            )),
                            Some((1, 0, 0, 0))
                        );
                    }
                    if tail == "  continuation\n" {
                        assert!(code);
                        assert_eq!(first_item, Some(false));
                        assert_eq!(session.context.fence_edge, None);
                    }
                }
                other => panic!("unexpected exact physical edge: {other:?}"),
            }
        }
        let derived = real.stage_body_source(prefix, 0..full.len());
        let grandchild = derived.stage_source(prefix, 0..prefix.len());
        assert!(matches!(derived.physical_tail(), PhysicalTail::Unknown));
        assert!(matches!(grandchild.physical_tail(), PhysicalTail::Unknown));
    }
}

#[test]
fn exact_window_inside_a_physical_code_row_has_no_boundary_proof() {
    let raw = "- parent\n  ```\n  opaque\n- outside";
    let real = EditorSession::open(raw);
    let end = raw.find("opaque").unwrap() + 2;
    let staged = real.stage_source(&raw[..end], 0..end);
    assert!(matches!(staged.physical_tail(), PhysicalTail::Unknown));
}

#[test]
fn an_interior_cut_of_a_staged_window_does_not_recertify_flattened_attribution() {
    let raw = "- parent\n  > b\n  > c\n- outside";
    let real = EditorSession::open(raw);
    let start = raw.find("> b").unwrap();
    let staged = real.stage_source(&raw[start..], start..raw.len());
    let end = staged.source_text().find("- outside").unwrap();
    let nested = staged.stage_source(&staged.source_text()[..end], 0..end);
    assert!(matches!(nested.physical_tail(), PhysicalTail::Unknown));
}

#[test]
fn physical_eof_and_original_item_authority_are_orthogonal_in_trimmed_exact_windows() {
    let raw = "- owner\n  > ~~~\n  > - parent\n  > ```\n  > opaque\n";
    let real = EditorSession::open(raw);
    let whole = real.stage_source(raw, 0..raw.len());
    assert!(matches!(whole.physical_tail(), PhysicalTail::Eof));
    assert_eq!(
        whole
            .context
            .fence_edge
            .map(|f| (f.depth, f.list_quote, f.code_quote)),
        Some((1, 0, 1))
    );
    let start = raw.find("- parent").unwrap();
    let trimmed = whole.stage_source(&raw[start..], start..raw.len());
    assert!(matches!(trimmed.physical_tail(), PhysicalTail::Eof));
    assert_eq!(trimmed.context.fence_edge, None);
    let direct = real.stage_source(&raw[start..], start..raw.len());
    assert!(matches!(direct.physical_tail(), PhysicalTail::Eof));
    assert_eq!(direct.context.fence_edge, None);
    let derived = real.stage_body_source(raw, 0..raw.len());
    assert!(matches!(derived.physical_tail(), PhysicalTail::Unknown));
    assert_eq!(derived.context.fence_edge, None);
}
