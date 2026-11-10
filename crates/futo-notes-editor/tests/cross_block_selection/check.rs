//! The cross-block selection checker, shared by the integration tests and
//! the in-crate property run (`session/blocks/cross_code_tests.rs`), and its
//! block oracle: pulldown-cmark read on its own, not the engine.
#![allow(dead_code)] // each includer uses its own part
use super::*;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

pub(crate) fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Input {
    Type(&'static str),
    Paste(&'static str),
    Commit(&'static str),
    Enter,
    Backspace,
    Delete,
    /// A text service's replacement (`replace_os`), as iOS types over a
    /// selection; `Kept` types the selection's last letter, which the
    /// service keeps as a run of its own.
    Os(&'static str),
    Kept,
    /// Two runs (`replace_many`): the range's halves, typed `d` and `e`.
    Many,
}

impl Input {
    pub(crate) const ALL: [Input; 6] = [
        Input::Type("d"),
        Input::Paste("pp"),
        Input::Commit("kk"),
        Input::Enter,
        Input::Backspace,
        Input::Delete,
    ];

    /// What the input shows in place of `selected`.
    fn shown(self, selected: &str) -> String {
        match self {
            Input::Type(text) | Input::Paste(text) | Input::Commit(text) | Input::Os(text) => {
                text.into()
            }
            Input::Kept => kept(selected).into(),
            Input::Many => "de".into(),
            Input::Enter => "\n".into(),
            Input::Backspace | Input::Delete => String::new(),
        }
    }
}

/// The selection's last letter or digit, else `k`.
fn kept(selected: &str) -> String {
    let last = selected.chars().rev().find(|ch| ch.is_alphanumeric());
    last.unwrap_or('k').to_string()
}

pub(crate) fn apply(
    s: &mut EditorSession,
    at: DisplayRange,
    input: Input,
) -> Result<(), EditorError> {
    s.select(s.revision(), at)?;
    let rev = s.revision();
    let accept = &mut |_: &SourceEdit| Ok(());
    match input {
        Input::Type(text) => s.replace(rev, at, text, accept).map(drop),
        Input::Paste(text) => s.paste_markdown(rev, at, text, accept).map(drop),
        Input::Commit(text) => {
            s.compose(rev, at, text)?;
            s.commit_composition(rev, None, accept).map(drop)
        }
        Input::Enter => s
            .paragraph_key(rev, at, ParagraphKey::Enter, accept)
            .map(drop),
        Input::Backspace => s
            .paragraph_key(rev, at, ParagraphKey::Backspace, accept)
            .map(drop),
        Input::Delete => s
            .paragraph_key(rev, at, ParagraphKey::Delete, accept)
            .map(drop),
        Input::Os(_) | Input::Kept => {
            let selected = s.display_text()[at.start.0..at.end.0].to_owned();
            let text = input.shown(&selected);
            s.replace_os(rev, at, &text, &[], accept).map(drop)
        }
        Input::Many => {
            let shown = s.display_text();
            let mut half = (at.start.0 + at.end.0) / 2;
            while !shown.is_char_boundary(half) {
                half -= 1;
            }
            let run = |start, end, text: &str| DisplayReplacement {
                range: range(start, end),
                inserted: text.into(),
            };
            let runs = if at.start.0 < half && half < at.end.0 {
                vec![run(at.start.0, half, "d"), run(half, at.end.0, "e")]
            } else {
                vec![run(at.start.0, at.end.0, "de")]
            };
            s.replace_many(rev, &runs, accept).map(drop)
        }
    }
}

/// A shown line's block, read from the parser on its own: code, heading
/// level, quote depth and list nesting.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Kind {
    code: bool,
    heading: u8,
    quote: u8,
    list: u8,
    /// The line begins its paragraph, heading, item or code block.
    starts: bool,
}

/// Each nonblank shown line's text and `Kind`.
pub(crate) fn lines(source: &str) -> Vec<(String, Kind)> {
    let options = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut out: Vec<(String, Kind)> = Vec::new();
    let mut line = String::new();
    let mut kind = Kind {
        code: false,
        heading: 0,
        quote: 0,
        list: 0,
        starts: false,
    };
    // The kind of the line being read, and whether a block began before it.
    let mut line_kind = kind.clone();
    let mut fresh = false;
    let mut flush = |line: &mut String, kind: &Kind, fresh: &mut bool| {
        let text = line.trim_end_matches('\r');
        if !text.trim().is_empty() {
            let starts = std::mem::take(fresh);
            out.push((
                text.to_owned(),
                Kind {
                    starts,
                    ..kind.clone()
                },
            ));
        }
        line.clear();
    };
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(tag) => {
                match tag {
                    Tag::CodeBlock(_) => kind.code = true,
                    Tag::Heading { level, .. } => kind.heading = level as u8,
                    Tag::BlockQuote(_) => kind.quote += 1,
                    Tag::Item => kind.list += 1,
                    _ => {}
                }
                if matches!(
                    tag,
                    Tag::Paragraph | Tag::Heading { .. } | Tag::CodeBlock(_) | Tag::Item
                ) {
                    flush(&mut line, &line_kind, &mut fresh);
                    fresh = true;
                }
                line_kind = kind.clone();
            }
            Event::End(end) => {
                flush(&mut line, &line_kind, &mut fresh);
                match end {
                    TagEnd::CodeBlock => kind.code = false,
                    TagEnd::Heading(_) => kind.heading = 0,
                    TagEnd::BlockQuote(_) => kind.quote -= 1,
                    TagEnd::Item => kind.list -= 1,
                    _ => {}
                }
                line_kind = kind.clone();
            }
            Event::Text(text) | Event::Code(text) if line_kind.code => {
                let mut parts = text.split('\n').peekable();
                while let Some(part) = parts.next() {
                    line.push_str(part);
                    if parts.peek().is_some() {
                        flush(&mut line, &line_kind, &mut fresh);
                    }
                }
            }
            Event::Text(text) | Event::Code(text) => line.push_str(&text),
            Event::SoftBreak | Event::HardBreak => flush(&mut line, &line_kind, &mut fresh),
            _ => {}
        }
    }
    flush(&mut line, &line_kind, &mut fresh);
    out
}

/// Applies `input` over `[a, b)`. Refused, the source is unchanged and the
/// result is `None`. Accepted, the display is the old one with the range
/// replaced (Enter's break may be its caret line's CRLF), a reopen shows
/// the same, every nonblank line before the range's first line and after its
/// last keeps its text and `Kind`, and Undo restores the exact source and
/// selection; the result is the new source.
pub(crate) fn checked(note: &str, a: usize, b: usize, input: Input) -> Option<String> {
    checked_as(note, a, b, input, &|| true)
}

/// `checked`, its display and `Kind` checks only when `exact` says so once
/// the input is accepted.
pub(crate) fn checked_as(
    note: &str,
    a: usize,
    b: usize,
    input: Input,
    exact: &dyn Fn() -> bool,
) -> Option<String> {
    let mut s = EditorSession::open(note);
    let old = s.display_text();
    let label = format!("{input:?} over {:?} [{a},{b}) of {note:?}", &old[a..b]);
    if let Err(error) = apply(&mut s, range(a, b), input) {
        assert_eq!(s.source_text(), note, "{error:?}: {label}");
        return None;
    }
    let source = s.source_text();
    let shown = s.display_text();
    assert_eq!(
        EditorSession::open(&source).display_text(),
        shown,
        "{label}\nreopened {source:?}"
    );
    if exact() {
        exactly_replaced(note, &old, a, b, input, &source, &shown, &label);
    }
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), note, "{label}: Undo");
    assert_eq!(s.selection(), range(a, b), "{label}: Undo selection");
    Some(source)
}

#[allow(clippy::too_many_arguments)]
fn exactly_replaced(
    note: &str,
    old: &str,
    a: usize,
    b: usize,
    input: Input,
    source: &str,
    shown: &str,
    label: &str,
) {
    let expected = |input: &str| format!("{}{input}{}", &old[..a], &old[b..]);
    // Enter's break is spelled as its caret line ends: CRLF if a source line
    // from the one before the selection's (an item a split continues) to its
    // last ends so.
    let session = EditorSession::open(note);
    let line_start = |at: usize| note[..at].rfind('\n').map_or(0, |end| end + 1);
    let source_at = |at: usize| {
        let at = session.source_at(session.revision(), DisplayOffset(at), Affinity::Forward);
        at.unwrap().0
    };
    let from = line_start(line_start(source_at(a)).saturating_sub(1));
    let last = line_start(source_at(b));
    let to = note[last..]
        .find('\n')
        .map_or(note.len(), |end| last + end + 1);
    let crlf = note[from..to].contains("\r\n");
    assert!(
        shown == expected(&input.shown(&old[a..b]))
            || input == Input::Enter && crlf && shown == expected("\r\n"),
        "{label}\nsource {source:?}\nshows {shown:?}\nexpected {:?}",
        expected(&input.shown(&old[a..b]))
    );
    let (old_lines, new_lines) = (lines(note), lines(source));
    let nonblank = |text: &str| {
        text.split('\n')
            .filter(|line| !line.trim().is_empty())
            .count()
    };
    // The oracle reads lines as the display shows them, or it is no oracle.
    if old_lines.iter().map(|line| line.0.as_str()).eq(old
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty()))
    {
        let before = nonblank(&old[..old[..a].rfind('\n').map_or(0, |at| at + 1)]);
        let after = old[b..]
            .find('\n')
            .map_or(0, |at| nonblank(&old[b + at + 1..]));
        // The rest of a block the input cut may begin a block of its own;
        // a line that began one still does (two blocks never become one).
        let split = |old: &(String, Kind), new: &(String, Kind)| {
            old.0 == new.0
                && Kind {
                    starts: true,
                    ..old.1.clone()
                } == new.1
        };
        let kept = before + after <= new_lines.len()
            && old_lines[..before] == new_lines[..before]
            && old_lines[old_lines.len() - after..]
                .iter()
                .zip(&new_lines[new_lines.len() - after..])
                .enumerate()
                .all(|(at, (old, new))| old == new || at == 0 && split(old, new));
        assert!(
            kept,
            "{label}\nsource {source:?}\nlines {old_lines:?}\nbecame {new_lines:?}"
        );
    }
}
