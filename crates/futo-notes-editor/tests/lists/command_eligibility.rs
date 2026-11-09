//! Indent and Outdent nest and un-nest list items and tab code lines; they are
//! lit exactly where that can happen. This is the generated property test; the
//! spelled examples are in `nesting_examples.rs`.
use super::*;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// (text, list depth, quote depth) for every text in `source`, read by an
/// independent CommonMark parser.
pub(super) fn parsed_texts(source: &str) -> Vec<(String, usize, usize)> {
    let (mut lists, mut quotes) = (0, 0);
    let mut items = Vec::new();
    for event in Parser::new_ext(source, Options::ENABLE_TASKLISTS) {
        match event {
            Event::Start(Tag::List(_)) => lists += 1,
            Event::End(TagEnd::List(_)) => lists -= 1,
            Event::Start(Tag::BlockQuote(_)) => quotes += 1,
            Event::End(TagEnd::BlockQuote(_)) => quotes -= 1,
            Event::Text(text) => items.push((text.to_string(), lists, quotes)),
            _ => {}
        }
    }
    items
}

/// The generated list items, `x0`, `x1`, ...
fn parsed_items(source: &str) -> Vec<(String, usize, usize)> {
    let mut items = parsed_texts(source);
    items.retain(|(text, ..)| text.starts_with('x'));
    items
}

struct Doc {
    source: String,
    /// Nesting level of each item `x0`, `x1`, ... in the generated list.
    levels: Vec<usize>,
    /// Whether the document holds a fenced code block, whose body line is `code`.
    fence: bool,
}

impl Doc {
    fn has_previous_sibling(&self, item: usize) -> bool {
        let level = self.levels[item];
        self.levels[..item]
            .iter()
            .rev()
            .take_while(|&&other| other >= level)
            .any(|&other| other == level)
    }

    /// The item and its descendants.
    fn subtree(&self, item: usize) -> std::ops::Range<usize> {
        let end = self.levels[item + 1..]
            .iter()
            .position(|&level| level <= self.levels[item])
            .map_or(self.levels.len(), |at| item + 1 + at);
        item..end
    }
}

/// Every combination of list marker, quote, nesting and fence placement.
fn docs() -> Vec<Doc> {
    let mut docs = Vec::new();
    // (marker for level 0.., content width)
    for (marker, ordered, width) in [
        ("- ", false, 2),
        ("* ", false, 2),
        ("+ ", false, 2),
        ("- [ ] ", false, 2),
        ("1. ", true, 3),
    ] {
        for quote in ["", "> "] {
            for levels in [
                vec![0, 0, 0],
                vec![0, 1, 0, 0],
                vec![0, 0, 1],
                vec![0, 1, 1, 0],
                vec![0, 0, 0, 1, 1],
            ] {
                for tail in [None, Some("tail"), Some("```\ncode\n```")] {
                    for fenced_item in [None, Some(0)] {
                        if fenced_item.is_some() && tail.is_some_and(|tail| tail.starts_with("```"))
                        {
                            continue;
                        }
                        let mut counters = vec![0; 4];
                        let mut lines = Vec::new();
                        for (n, &level) in levels.iter().enumerate() {
                            counters[level] += 1;
                            counters[level + 1..].fill(0);
                            let label = if ordered {
                                format!("{}. ", counters[level])
                            } else {
                                marker.to_string()
                            };
                            lines.push(format!("{quote}{}{label}x{n}", " ".repeat(width * level)));
                            if fenced_item == Some(n) {
                                let indent = " ".repeat(width * (level + 1));
                                lines.push(format!("{quote}{indent}```"));
                                lines.push(format!("{quote}{indent}code"));
                                lines.push(format!("{quote}{indent}```"));
                            }
                        }
                        let mut source = lines.join("\n");
                        if let Some(tail) = tail {
                            source.push_str("\n\n");
                            source.push_str(tail);
                        }
                        docs.push(Doc {
                            source,
                            levels: levels.clone(),
                            fence: tail.is_some_and(|tail| tail.starts_with("```"))
                                || fenced_item.is_some(),
                        });
                    }
                }
            }
        }
    }
    docs
}

pub(super) fn caret_in(s: &mut EditorSession, text: &str) {
    let at = s.display_text().find(text).unwrap() + 1;
    s.select(s.revision(), range(at, at)).unwrap();
}

pub(super) fn command(s: &mut EditorSession, command: BlockCommand) -> Option<ViewChange> {
    s.block_command(s.revision(), s.selection(), command, &mut |_| Ok(()))
        .unwrap_or_else(|error| panic!("{:?}: {command:?} refused: {error:?}", s.source_text()))
}

/// A command that does nothing: no change, no accepted edit, no Undo step.
pub(super) fn assert_no_op(s: &mut EditorSession, what: BlockCommand, context: &str) {
    let (source, revision) = (s.source_text(), s.revision());
    let undoable = s.toolbar_state().can_undo;
    assert!(
        s.block_command(s.revision(), s.selection(), what, &mut |_| {
            panic!("{context}: {what:?} accepted an edit")
        })
        .unwrap()
        .is_none(),
        "{context}: {what:?}"
    );
    assert_eq!(s.source_text(), source, "{context}");
    assert_eq!(s.revision(), revision, "{context}");
    assert_eq!(s.toolbar_state().can_undo, undoable, "{context}");
}

#[test]
fn indent_and_outdent_nest_and_un_nest_every_item_that_can_and_do_nothing_elsewhere() {
    let mut nested = 0;
    for doc in docs() {
        let before = parsed_items(&doc.source);
        assert_eq!(before.len(), doc.levels.len(), "{:?}", doc.source);
        for item in 0..doc.levels.len() {
            let name = format!("x{item}");
            let context = format!("{:?} at {name}", doc.source);
            let level = doc.levels[item];
            let mut s = EditorSession::open(&doc.source);
            let text = s.display_text();
            caret_in(&mut s, &name);
            let state = s.toolbar_state();
            assert_eq!(
                state.can_indent,
                doc.has_previous_sibling(item),
                "{context}"
            );
            assert_eq!(state.can_outdent, level > 0, "{context}");

            if !doc.has_previous_sibling(item) {
                assert_no_op(&mut s, BlockCommand::Indent, &context);
            } else {
                let tab = {
                    let mut tab = EditorSession::open(&doc.source);
                    caret_in(&mut tab, &name);
                    tab.paragraph_key(
                        tab.revision(),
                        tab.selection(),
                        ParagraphKey::Tab,
                        &mut |_| Ok(()),
                    )
                    .unwrap();
                    tab.source_text()
                };
                nested += 1;
                command(&mut s, BlockCommand::Indent)
                    .unwrap_or_else(|| panic!("{context}: Indent did nothing"));
                let after = parsed_items(&s.source_text());
                for (at, (item_text, depth, quote)) in after.iter().enumerate() {
                    let nested = doc.subtree(item).contains(&at);
                    assert_eq!(
                        (item_text, *depth, *quote),
                        (
                            &before[at].0,
                            before[at].1 + usize::from(nested),
                            before[at].2
                        ),
                        "{context}: {:?}",
                        s.source_text()
                    );
                }
                assert_eq!(s.display_text(), text, "{context}: text");
                assert_eq!(s.source_text(), tab, "{context}: Tab");
                // And back out again.
                let nested = s.source_text();
                caret_in(&mut s, &name);
                command(&mut s, BlockCommand::Outdent)
                    .unwrap_or_else(|| panic!("{context}: Outdent did nothing"));
                assert_eq!(
                    parsed_items(&s.source_text()),
                    before,
                    "{context}: {:?}",
                    s.source_text()
                );
                assert_eq!(s.display_text(), text, "{context}: text");
                s.undo(s.revision(), &mut |_| Ok(())).unwrap();
                assert_eq!(s.source_text(), nested, "{context}: Undo of Outdent");
                s.undo(s.revision(), &mut |_| Ok(())).unwrap();
                assert_eq!(s.source_text(), doc.source, "{context}: Undo");
                assert!(!s.toolbar_state().can_undo, "{context}");
            }

            let mut s = EditorSession::open(&doc.source);
            caret_in(&mut s, &name);
            if level == 0 {
                assert_no_op(&mut s, BlockCommand::Outdent, &context);
            } else {
                command(&mut s, BlockCommand::Outdent)
                    .unwrap_or_else(|| panic!("{context}: Outdent did nothing"));
                assert_eq!(
                    parsed_items(&s.source_text())[item].1,
                    before[item].1 - 1,
                    "{context}: {:?}",
                    s.source_text()
                );
                s.undo(s.revision(), &mut |_| Ok(())).unwrap();
                assert_eq!(s.source_text(), doc.source, "{context}: Undo");
            }
        }
        if doc.fence {
            let mut s = EditorSession::open(&doc.source);
            caret_in(&mut s, "code");
            assert!(s.toolbar_state().can_indent, "{:?}", doc.source);
            assert!(!s.toolbar_state().can_outdent, "{:?}", doc.source);
            assert_no_op(&mut s, BlockCommand::Outdent, &doc.source);
            command(&mut s, BlockCommand::Indent).unwrap();
            // A tab on the code line, after its container prefix; no fence line moves.
            let tabbed: Vec<String> = doc
                .source
                .lines()
                .map(|line| match line.find("code") {
                    Some(at) => format!("{}\tcode", &line[..at]),
                    None => line.to_string(),
                })
                .collect();
            assert_eq!(s.source_text(), tabbed.join("\n"), "{:?}", doc.source);
            caret_in(&mut s, "code");
            command(&mut s, BlockCommand::Outdent).unwrap_or_else(|| {
                panic!("{:?} -> {:?} Outdent none", doc.source, s.source_text())
            });
            assert_eq!(s.source_text(), doc.source);
            s.undo(s.revision(), &mut |_| Ok(())).unwrap();
            s.undo(s.revision(), &mut |_| Ok(())).unwrap();
            assert_eq!(s.source_text(), doc.source);
            assert!(!s.toolbar_state().can_undo);
        }
    }
    assert!(nested > 300, "the shapes nest {nested} items");
}
