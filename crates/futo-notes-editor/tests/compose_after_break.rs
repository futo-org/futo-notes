//! #413: committing a composition with the caret right after a thematic
//! break (a parser-owned atom) must never panic, and must land like typing.
use futo_notes_editor::*;

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

/// Where the caret goes: the end of the display, or right after the first rule.
fn caret_for(session: &EditorSession, after_rule: bool) -> usize {
    let shown = session.display_text();
    match shown.find('\u{FFFC}').filter(|_| after_rule) {
        Some(at) => at + '\u{FFFC}'.len_utf8(),
        None => shown.len(),
    }
}

/// Composes `text` at the caret, then commits it.
fn compose_at_end(source: &str, text: &str, after_rule: bool) -> EditorSession {
    let mut session = EditorSession::open(source);
    let end = caret_for(&session, after_rule);
    session.select(session.revision(), caret(end)).unwrap();
    session
        .compose(session.revision(), caret(end), text)
        .unwrap();
    let _ = session.commit_composition(session.revision(), Some(text), &mut |_| Ok(()));
    session
}

/// Types `text` at the end of the display one scalar at a time.
fn type_at_end(source: &str, text: &str, after_rule: bool) -> EditorSession {
    let mut session = EditorSession::open(source);
    let mut end = caret_for(&session, after_rule);
    for c in text.chars() {
        session
            .replace(session.revision(), caret(end), &c.to_string(), &mut |_| {
                Ok(())
            })
            .unwrap();
        end = session.selection().end.0;
    }
    session
}

#[test]
fn composition_commit_after_break_matches_typing() {
    let sources = [
        "---",
        "***",
        "___",
        "- a\n\n---",
        "a\n\n---",
        "a\n---",
        "# H",
        "```\nx\n```",
        "> quote\n\n---\n# Heading\n\nx",
        "a\n\n---\n",
        "a\n\n---\n\nb",
        "# H\n\n***\n# T",
    ];
    let texts = ["é", "日本", "a", "éé"];
    let mut bad = Vec::new();
    for source in sources {
        for after_rule in [false, true] {
            for text in texts {
                let got = std::panic::catch_unwind(|| {
                    let s = compose_at_end(source, text, after_rule);
                    format!("{:?} caret {:?}", s.source_text(), s.selection())
                });
                let want = std::panic::catch_unwind(|| {
                    let s = type_at_end(source, text, after_rule);
                    format!("{:?} caret {:?}", s.source_text(), s.selection())
                })
                .unwrap_or_else(|_| "<typing panicked>".into());
                match got {
                Ok(got) if got == want => {}
                Ok(got) => bad.push(format!(
                    "{source:?} rule_caret={after_rule} + {text:?}: composed {got:?}, typed {want:?}"
                )),
                Err(_) => bad.push(format!("{source:?} rule_caret={after_rule} + {text:?}: PANIC (typed {want:?})")),
            }
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
