//! Inline commands in the property run: format toggles and link commands at
//! random selections, where properties 3 and 4 hold as for typing, and
//! typing under carried formats.
use super::*;
use crate::InlineFormat;

const FORMATS: [InlineFormat; 4] = [
    InlineFormat::Bold,
    InlineFormat::Italic,
    InlineFormat::Strike,
    InlineFormat::Code,
];

/// A format toggle or link command at the selection. A toggle over a
/// selection keeps the display and the selection. A collapsed toggle writes
/// nothing; the formats it carries are dropped at once, so the typing steps
/// that follow stay exact (property 2).
pub(super) fn inline_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let revision = engine.revision();
    let before = state(engine);
    let source = engine.source_text();
    let groups = engine.history.undo.len();
    let selection = engine.selection();
    let shown = engine.display_text();
    let pick = random.below(6);
    let (result, name) = match pick {
        0..=3 => (
            engine.toggle_format_view(revision, FORMATS[pick], &mut ok),
            format!("toggle {:?} at {selection:?}", FORMATS[pick]),
        ),
        4 => {
            let destination = random.pick(&["https://x.y", "", "a b", "n(1"]);
            (
                engine.set_link_view(revision, selection, destination, &mut ok),
                format!("link {destination:?} at {selection:?}"),
            )
        }
        _ => {
            let label = random.pick(&["l", "", "*x*", "a]b", "[c]"]);
            let destination = random.pick(&["https://x.y", "", "n"]);
            (
                engine.edit_link_view(revision, selection, label, destination, &mut ok),
                format!("edit link {label:?} {destination:?} at {selection:?}"),
            )
        }
    };
    engine.formats = None;
    match result {
        Ok(Some(change)) => {
            view.text
                .replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            view.restyled
                .push(change.projection.range.start.0..change.projection.range.end.0);
            assert_eq!(change.revision, engine.revision(), "{name}");
            if pick < 4 {
                assert_eq!(engine.display_text(), shown, "{name} changed the display");
                assert_eq!(engine.selection(), selection, "{name} moved the selection");
            }
            model.edited(engine, before, groups);
        }
        Ok(None) | Err(EditorError::UnrepresentableFormat | EditorError::InvalidText) => {
            assert_eq!(engine.revision(), revision, "{name} changed nothing");
            assert_eq!(engine.source_text(), source, "{name} changed nothing");
        }
        Err(error) => panic!("{name}: {error:?}"),
    }
    name
}

/// Typing under carried formats, inside a line's text: the typed text shows
/// where the caret was and nothing else on screen changes, and (outside
/// code, links and atoms) it has exactly the carried formats. Where the
/// line cannot spell that (CommonMark's flanking rules on one line, or
/// typing that breaks the syntax around it), the text lands exactly as
/// plain typing would. Undo then restores the note's bytes.
#[test]
fn typing_under_carried_formats_shows_exactly_what_was_typed() {
    let mut random = Random::from_env();
    let mut formatted = 0;
    for case in 0..cases().div_ceil(4) {
        let original = note(&mut random);
        let mut engine = Engine::open(&original);
        let mut steps = Vec::new();
        for _ in 0..8 {
            let at = display_offset(&engine, &mut random);
            let affinity = if random.below(2) == 0 {
                Affinity::Backward
            } else {
                Affinity::Forward
            };
            let caret = DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            };
            engine
                .select_with_affinity(engine.revision(), caret, affinity)
                .unwrap();
            for _ in 0..=random.below(3) {
                let format = FORMATS[random.below(4)];
                engine
                    .toggle_format_view(engine.revision(), format, &mut ok)
                    .unwrap();
                steps.push(format!("toggle {format:?} at {at} {affinity:?}"));
            }
            let carried = engine.formats.clone();
            for _ in 0..=random.below(4) {
                let text = random.pick(&["a", "b", " ", "é", "x y", "😀"]);
                let shown = engine.display_text();
                let caret = engine.selection();
                let plain = {
                    let mut plain = engine.source_text();
                    plain.insert_str(engine.caret_source(), text);
                    plain
                };
                // Typing that makes a block of its own (a space opening an
                // indent, text in front of a divider) is the core's typing,
                // not the formats'; check typing inside a line's text.
                let (index, before) =
                    engine.line_at_display(crate::engine::store::display, caret.start.0);
                let entry = engine.store.get(index);
                let inside = caret.start.0 > before.display
                    && entry.view.role == Role::Text
                    && matches!(
                        entry.line.kind,
                        Kind::Plain { .. }
                            | Kind::Heading { .. }
                            | Kind::List { .. }
                            | Kind::Table {
                                role: TableRole::Header | TableRole::Row,
                                ..
                            }
                    );
                engine
                    .replace(engine.revision(), caret, text, InputAction::Typing, &mut ok)
                    .unwrap();
                steps.push(format!("type {text:?}"));
                let context = format!(
                    "case {case} from {original:?} after {steps:?}, now {:?}",
                    engine.source_text()
                );
                check_fresh(&engine, &context);
                if !inside {
                    continue;
                }
                let mut want = shown.clone();
                want.insert_str(caret.start.0, text);
                if engine.display_text() != want {
                    // Typing that breaks the syntax around it (a space in an
                    // autolink) is plain typing, exactly.
                    assert_eq!(engine.source_text(), plain, "{context}");
                    continue;
                }
                assert_eq!(
                    engine.selection().start.0,
                    caret.start.0 + text.len(),
                    "{context}"
                );
                if let Some(carried) = &carried {
                    formatted += usize::from(typed_formats(
                        &engine,
                        caret.start.0,
                        text,
                        carried,
                        &plain,
                        &context,
                    ));
                }
            }
        }
        while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {}
        assert_eq!(
            engine.source_text(),
            original,
            "case {case} undone after {steps:?}"
        );
    }
    assert!(formatted > 0, "no typing was checked for its formats");
}

/// Check that `text`, typed at display `at`, shows in `carried` formats
/// or landed as `plain` typing; whether it showed in them.
fn typed_formats(
    engine: &Engine,
    at: usize,
    text: &str,
    carried: &[InlineFormat],
    plain: &str,
    context: &str,
) -> bool {
    let (index, _) = engine.line_at_display(crate::engine::store::display, at);
    let entry = engine.store.get(index);
    let textual = matches!(
        entry.line.kind,
        Kind::Plain { .. } | Kind::Blank | Kind::Heading { .. } | Kind::List { .. }
    ) && entry.view.role == Role::Text;
    // Text inside a link, wikilink, image or tag takes formats only with
    // the whole of it.
    let reached = |offset: usize| {
        let around = engine.projection(
            engine.revision(),
            DisplayRange {
                start: DisplayOffset(offset),
                end: DisplayOffset(offset),
            },
        );
        let near = |range: &DisplayRange| range.start.0 <= offset && offset <= range.end.0;
        around.links.iter().any(|link| near(&link.range))
            || around.wikilinks.iter().any(|link| near(&link.range))
            || around.atoms.iter().any(|atom| near(&atom.range))
            || entry_has_tag_at(engine, offset)
    };
    let slice = engine.projection(
        engine.revision(),
        DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at + text.len()),
        },
    );
    let inside_code = |offset: usize| {
        slice.runs.iter().any(|run| {
            run.range.start.0 < offset
                && offset < run.range.end.0
                && run.formats.contains(&InlineFormat::Code)
        })
    };
    if !textual || carried.contains(&InlineFormat::Code) || reached(at) || inside_code(at) {
        return false;
    }
    for (offset, ch) in text.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        let at = at + offset;
        let mut formats: Vec<InlineFormat> = slice
            .runs
            .iter()
            .filter(|run| run.range.start.0 <= at && at < run.range.end.0)
            .flat_map(|run| run.formats.clone())
            .collect();
        formats.sort();
        formats.dedup();
        if formats != carried {
            assert_eq!(
                engine.source_text(),
                plain,
                "typed {text:?} at {at} is neither {carried:?} nor plain typing: {context}"
            );
            return false;
        }
    }
    true
}

/// Whether display `offset` touches a tag.
fn entry_has_tag_at(engine: &Engine, offset: usize) -> bool {
    let (index, before) = engine.line_at_display(crate::engine::store::display, offset);
    let entry = engine.store.get(index);
    entry.spans.iter().any(|span| {
        span.kind == SpanKind::Tag
            && before.display + entry.to_display(span.range.start) <= offset
            && offset <= before.display + entry.to_display(span.range.end)
    })
}
