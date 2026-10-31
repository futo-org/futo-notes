//! Exact raw-library positions are independent of decoded visible-text searches.
use super::*;

#[test]
fn raw_gfm_positions_distinguish_repeated_uri_text_after_code_brackets_and_an_entity() {
    let source = "https://x.test/a `https://x.test/a` [https://x.test/a] &amp; https://x.test/a";
    let shown = "https://x.test/a https://x.test/a [https://x.test/a] & https://x.test/a";
    let ast = markdown::to_mdast(
        source,
        &markdown::ParseOptions {
            constructs: markdown::Constructs {
                gfm_autolink_literal: true,
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    let mut stack = vec![&ast];
    let mut raw_links = Vec::new();
    while let Some(node) = stack.pop() {
        if let markdown::mdast::Node::Link(link) = node {
            let position = link
                .position
                .as_ref()
                .expect("the pinned raw event compiler supplies exact Link positions");
            raw_links.push((
                position.start.offset,
                position.end.offset,
                link.url.as_str(),
            ));
        }
        if let Some(children) = node.children() {
            stack.extend(children.iter().rev());
        }
    }
    assert_eq!(
        raw_links,
        vec![
            (0, 16, "https://x.test/a"),
            (37, 53, "https://x.test/a"),
            (61, 77, "https://x.test/a")
        ]
    );
    let editor = EditorSession::open(source);
    assert_eq!(editor.display_text(), shown);
    let links = editor
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(
        links
            .iter()
            .map(|link| (link.range, link.destination.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (range(0, 16), "https://x.test/a"),
            (range(35, 51), "https://x.test/a"),
            (range(55, 71), "https://x.test/a")
        ]
    );
}
