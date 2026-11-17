//! The list keys' and commands' counted work, held to the old engine's
//! `tests/long_regions*` budgets.
use super::super::{ok, range};
use super::select_source;
use crate::engine::Engine;
use crate::{Affinity, BlockCommand, InputAction, ParagraphKey};

/// Counted work: materialized and parsed source and metadata items, the
/// sum the old engine's `tests/long_regions*` budgets measure.
fn total(work: &crate::EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

fn key_at(engine: &mut Engine, at: usize, key: ParagraphKey) -> (usize, usize) {
    let change = engine
        .key(engine.revision(), range(at, at), key, &mut ok)
        .unwrap()
        .unwrap();
    (total(&change.work), change.selection.end.0)
}

/// `tests/long_regions.rs` `an_emptied_item_in_a_nested_list_stays_local`
/// on the core: Enter at a nested item's end, Backspace on the new empty
/// item, then typing. The old engine counted (Enter, Backspace, typing)
/// 1157, 1082, 1248 at 1,000 lines and 1347, 1372, 1482 at 20,000.
#[test]
fn an_emptied_item_in_a_nested_list_costs_no_more_than_before() {
    const DEPTHS: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 5, 6, 4, 5, 3];
    let line = |i: usize| {
        let indent = "    ".repeat(DEPTHS[i % 12]);
        match i % 4 {
            0 => format!("{indent}- ### Encounters n{i}z\n"),
            1 => format!("{indent}- 1d4 [owl {i}](https://example.com/owl-{i})s n{i}z\n"),
            2 => format!("{indent}- **d100** n{i}z\n"),
            _ => format!("{indent}- {:02}–{:02} n{i}z\n", i % 100, (i + 2) % 100),
        }
    };
    for (lines, old) in [(1_000, [1157, 1082, 1248]), (20_000, [1347, 1372, 1482])] {
        let source: String = (0..lines).map(line).collect();
        let middle = (lines / 2..).find(|&i| i % 12 == 6 && i % 4 != 0).unwrap();
        let mut engine = Engine::open(&source);
        let needle = format!("n{middle}z");
        let at = engine.display_text().find(&needle).unwrap() + needle.len();
        let (entered, at) = key_at(&mut engine, at, ParagraphKey::Enter);
        let (emptied, at) = key_at(&mut engine, at, ParagraphKey::Backspace);
        let typed = engine
            .input(
                engine.revision(),
                range(at, at),
                "x",
                InputAction::Typing,
                &mut ok,
            )
            .unwrap();
        let text = line(middle);
        assert_eq!(
            engine.source_text(),
            source.replacen(&text, &format!("{text}x\n"), 1),
            "{lines}"
        );
        let now = [entered, emptied, total(&typed.work)];
        for (key, (now, old)) in now.iter().zip(old).enumerate() {
            assert!(*now <= old, "{lines} lines, key {key}: {now} > {old}");
        }
    }
}

/// `tests/long_regions.rs`
/// `outdenting_an_empty_nested_item_reads_only_its_parents_list` on the
/// core: Enter twice at a nested item's end (the second outdents the new
/// empty item), bullets and numbers. The old engine counted (first, second
/// Enter) at 1,200 and 24,000 lines: bullets 1379, 1228 and 1827, 1732;
/// numbers 1390, 1243 and 1838, 1747.
#[test]
fn outdenting_an_empty_nested_item_costs_no_more_than_before() {
    const DEPTHS: [usize; 6] = [0, 1, 2, 2, 2, 1];
    for ordered in [false, true] {
        let line = |i: usize| {
            let depth = DEPTHS[i % 6];
            let indent = "    ".repeat(depth);
            let marker = if ordered && depth > 0 {
                let at = i % 6;
                let number = if depth == 1 {
                    usize::from(at == 5) + 1
                } else {
                    at - 1
                };
                format!("{number}.")
            } else {
                "-".to_owned()
            };
            format!("{indent}{marker} [owl {i}](https://example.com/owl-{i}) n{i}z\n")
        };
        let old = if ordered {
            [(1_200, [1390, 1243]), (24_000, [1838, 1747])]
        } else {
            [(1_200, [1379, 1228]), (24_000, [1827, 1732])]
        };
        for (lines, old) in old {
            let source: String = (0..lines).map(line).collect();
            let middle = (lines / 2..).find(|&i| i % 6 == 2).unwrap();
            let mut engine = Engine::open(&source);
            let needle = format!("n{middle}z");
            let at = engine.display_text().find(&needle).unwrap() + needle.len();
            let (first, at) = key_at(&mut engine, at, ParagraphKey::Enter);
            let (second, _) = key_at(&mut engine, at, ParagraphKey::Enter);
            // The empty item sits one level out after the middle item; the
            // two items after it now sit under it and count again from 1,
            // and the next item at its level is bumped.
            let (a, b, c, d) = (
                line(middle),
                line(middle + 1),
                line(middle + 2),
                line(middle + 3),
            );
            let after = if ordered {
                format!(
                    "{a}    2. \n{}{}{}",
                    b.replacen("2.", "1.", 1),
                    c.replacen("3.", "2.", 1),
                    d.replacen("2.", "3.", 1)
                )
            } else {
                format!("{a}    - \n{b}{c}{d}")
            };
            assert_eq!(
                engine.source_text(),
                source.replacen(&format!("{a}{b}{c}{d}"), &after, 1),
                "ordered {ordered} at {lines}"
            );
            for (key, (now, old)) in [first, second].iter().zip(old).enumerate() {
                assert!(
                    *now <= old,
                    "ordered {ordered}, {lines} lines, key {key}: {now} > {old}"
                );
            }
        }
    }
}

/// `tests/long_regions/list_toggle.rs`
/// `removing_one_middle_bullet_reads_only_its_neighboring_rows` on the
/// core. The old engine counted 770 at 1,000 lines and 1099 at 20,000.
#[test]
fn removing_one_middle_bullet_costs_no_more_than_before() {
    for (lines, old) in [(1_000, 770), (20_000, 1099)] {
        let source: String = (0..lines).map(|i| format!("- item {i}\n")).collect();
        let needle = format!("item {}", lines / 2);
        let mut engine = Engine::open(&source);
        let at = engine.display_text().find(&needle).unwrap();
        super::super::select(&mut engine, at, at, Affinity::Backward);
        let change = engine
            .block(
                engine.revision(),
                range(at, at),
                BlockCommand::BulletList,
                &mut ok,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            engine.source_text(),
            source.replacen(&format!("- {needle}\n"), &format!("{needle}\n"), 1)
        );
        let now = total(&change.work);
        assert!(now <= old, "{lines} lines: {now} > {old}");
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source);
        assert_eq!(engine.selection(), range(at, at));
    }
}

/// `tests/long_regions/block_selection.rs`
/// `list_commands_do_not_compare_every_span_with_every_line_boundary` on
/// the core: 1,000 bold headings become bullets. The old engine counted
/// 1,158,673 in all, 527,505 of it metadata items (budget 1,000 × (512 +
/// 8 × 10)).
#[test]
fn a_whole_note_list_toggle_costs_no_more_than_before() {
    let lines = 1_000usize;
    let source: String = (0..lines).map(|i| format!("# **row {i}**\n")).collect();
    let expected: String = (0..lines).map(|i| format!("- **row {i}**\n")).collect();
    let mut engine = Engine::open(&source);
    let end = engine.display_len();
    let selected = range(0, end);
    super::super::select(&mut engine, 0, end, Affinity::Forward);
    let change = engine
        .block(
            engine.revision(),
            selected,
            BlockCommand::BulletList,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), expected);
    let comparisons = usize::BITS as usize - lines.leading_zeros() as usize;
    assert!(change.work.link_metadata_items <= lines * (512 + 8 * comparisons));
    let now = total(&change.work);
    assert!(now <= 1_158_673, "{now}");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), source);
    assert_eq!(engine.selection(), selected);
}

/// Text-only edits settle without traversing the remaining list; structural
/// indent commands revisit only their descendants and the settling boundary.
#[test]
fn list_level_work_is_constant_for_typing_and_bounded_by_the_indented_subtree() {
    let measure = |count: usize, children: usize, command: Option<BlockCommand>| {
        let outdent = command == Some(BlockCommand::Outdent);
        let mut source = if outdent {
            "- prior\n  - target\n"
        } else {
            "- prior\n- target\n"
        }
        .to_owned();
        source.push_str(
            &if outdent {
                "    - child\n"
            } else {
                "  - child\n"
            }
            .repeat(children),
        );
        source.push_str(&"- sibling\n".repeat(count));
        let mut engine = Engine::open(&source);
        let at = engine.display_text().find("target").unwrap();
        select_source(
            &mut engine,
            source.find("target").unwrap()..source.find("target").unwrap(),
        );
        let change = if let Some(command) = command {
            engine
                .block(engine.revision(), range(at, at), command, &mut ok)
                .unwrap()
                .unwrap()
        } else {
            engine
                .input(
                    engine.revision(),
                    range(at, at),
                    "x",
                    InputAction::Typing,
                    &mut ok,
                )
                .unwrap()
        };
        let fresh = Engine::open(&engine.source_text());
        assert_eq!(
            engine
                .project(engine.revision(), range(0, engine.display_len()))
                .unwrap()
                .blocks,
            fresh
                .project(fresh.revision(), range(0, fresh.display_len()))
                .unwrap()
                .blocks
        );
        change.work
    };
    for command in [
        None,
        Some(BlockCommand::Indent),
        Some(BlockCommand::Outdent),
    ] {
        let small = measure(1_000, 7, command);
        let large = measure(20_000, 7, command);
        assert_eq!(small, large, "{command:?}");
        assert!(small.parsed_source_bytes < 640, "{small:?}");
    }
    let small = measure(20_000, 7, Some(BlockCommand::Indent));
    let large = measure(20_000, 70, Some(BlockCommand::Indent));
    assert!(large.parsed_source_bytes > small.parsed_source_bytes);
    assert!(large.parsed_source_bytes < 5_000, "{large:?}");
}

#[test]
fn renumbering_reads_the_changed_tail_once_and_undo_restores_its_spelling() {
    for ending in ["\n", "\r\n"] {
        let source: String = (1..=1_000)
            .map(|i| format!("{i:04}) item {i}{ending}"))
            .collect();
        let mut engine = Engine::open(&source);
        let display = engine.display_text();
        let at = display.find("item 500").unwrap() + "item 500".len();
        let change = engine
            .key(
                engine.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut ok,
            )
            .unwrap()
            .unwrap();
        assert!(
            change.work.parsed_source_bytes < source.len(),
            "{:?}",
            change.work
        );
        let mut expected: String = (1..=500)
            .map(|i| format!("{i:04}) item {i}{ending}"))
            .collect();
        expected.push_str(&format!("0501) {ending}"));
        expected.extend((501..=1_000).map(|i| format!("{:04}) item {i}{ending}", i + 1)));
        assert_eq!(engine.source_text(), expected);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source);
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), expected);
    }
}
