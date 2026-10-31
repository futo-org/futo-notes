//! Canonical attribution proof for the public list-fence promotion RED.
use crate::{DisplayOffset, DisplayRange};

#[test]
fn unmatched_fence_ranges_end_at_the_actual_list_item_boundary() {
    for (raw, marker, width, quote, ending) in [
        ("- parent\n  ```\n  opaque\n- outside", b'`', 3, 0, 1),
        (
            "- parent\r\n  ~~~~lang\r\n  opaque\r\n- outside",
            b'~',
            4,
            0,
            2,
        ),
        ("- parent\n  > ```\n  > opaque\n- outside", b'`', 3, 1, 1),
    ] {
        let p = crate::inline::Projection::new(raw);
        let all = p.block_lines(DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(p.display.len_bytes()),
        });
        let code = all.iter().find(|block| block.code).unwrap();
        let fence = code.fence.as_ref().unwrap();
        let boundary = raw.find("- outside").unwrap();
        let opener = raw.find(marker as char).unwrap();
        let physical = raw[..opener].rfind('\n').unwrap() + 1;
        let body = opener + raw[opener..].find('\n').unwrap() + 1;
        assert_eq!(fence.whole, opener..boundary);
        assert_eq!(fence.opener, opener..opener + width);
        assert_eq!(fence.body, body..boundary - ending);
        assert_eq!(fence.separator, boundary - ending..boundary);
        assert!(fence.closer.is_none());
        assert_eq!(fence.marker, marker);
        assert_eq!(fence.width, width);
        assert_eq!(code.quote_depth, quote);
        let list = code.list.as_ref().unwrap();
        assert_eq!(list.quote_depth, 0);
        assert_eq!(list.depth, 1);
        assert_eq!(list.content_column, 2);
        assert_eq!(list.marker, 0..1);
        assert_eq!(list.item, 0..boundary);
        assert_eq!(list.owner, 0..raw.len());
        let prefix = p.source_prefix_at(physical).unwrap();
        assert_eq!(prefix.prefix, physical..opener);
        assert!(prefix.code);
        assert_eq!(prefix.quote_depth, quote);
        assert_eq!(&raw[prefix.prefix], if quote == 0 { "  " } else { "  > " });
        let outside = p.source_prefix_at(boundary).unwrap();
        assert!(!outside.code);
        assert_eq!(outside.quote_depth, 0);
        assert_eq!(outside.list.as_ref().unwrap().item.start, boundary);
    }
}

#[test]
fn existing_closer_and_true_eof_have_distinct_canonical_ownership() {
    for raw in [
        "- parent\n  ```\n  opaque\n  ```\n- outside",
        "- parent\n  ```\n  opaque",
    ] {
        let p = crate::inline::Projection::new(raw);
        let blocks = p.block_lines(DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(p.display.len_bytes()),
        });
        let fence = blocks.iter().find_map(|b| b.fence.as_ref()).unwrap();
        if raw.ends_with("outside") {
            let marker = raw.rfind("```").unwrap();
            assert_eq!(fence.closer, Some(marker..marker + 3));
            let physical = raw.find("- outside").unwrap();
            assert_eq!(fence.whole.end, marker + 3);
            let block = blocks.iter().find(|b| b.fence.is_some()).unwrap();
            assert_eq!(block.list.as_ref().unwrap().item.end, physical);
            let closer = p
                .source_prefix_at(raw[..marker].rfind('\n').unwrap() + 1)
                .unwrap();
            assert_eq!(closer.source.end, physical);
            assert_eq!(physical, marker + 4);
        } else {
            assert!(fence.closer.is_none());
            assert_eq!(fence.whole.end, raw.len());
            assert_eq!(fence.body.end, raw.len());
            assert_eq!(fence.separator, raw.len()..raw.len());
        }
    }
}

#[test]
fn a_shared_outer_quote_ends_its_list_item_at_the_foreign_physical_line() {
    let raw = "> - parent\n>   ```\n>   opaque\n> - outside";
    let p = crate::inline::Projection::new(raw);
    let blocks = p.block_lines(DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(p.display.len_bytes()),
    });
    let code = blocks.iter().find(|b| b.code).unwrap();
    let fence = code.fence.as_ref().unwrap();
    let physical = raw.rfind("\n> - outside").unwrap() + 1;
    let outside_marker = physical + 2;
    assert_eq!(fence.whole.end, physical);
    assert_eq!(fence.separator, physical - 1..physical);
    let list = code.list.as_ref().unwrap();
    assert_eq!(list.marker, 2..3);
    assert_eq!(list.item, 2..physical);
    assert_eq!(list.content_column, 4);
    assert_eq!(list.quote_depth, 1);
    assert_eq!(code.quote_depth, 1);
    let outside = p.source_prefix_at(physical).unwrap();
    assert!(!outside.code);
    assert_eq!(outside.quote_depth, 1);
    assert_eq!(outside.list.as_ref().unwrap().marker.start, outside_marker);
}
