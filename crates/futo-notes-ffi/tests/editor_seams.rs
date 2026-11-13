//! Native input paths across line seams (text-service runs, marked text,
//! explicit runs, typing sequences, code lines): each case's exact source,
//! caret, history, and the bytes a save writes and a reopen reads. Ported
//! from the CommonMark-era `structural-seams.json` and
//! `fence-physical-rows.json`: entities became the characters they spelled,
//! fences left quotes (a fence is not recognised after `>`), and the rows
//! that pinned a setext, entity or `***` repair now land as typed.
mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};

fn range(a: u64, z: u64) -> EditorUtf16Range {
    EditorUtf16Range { start: a, end: z }
}

#[path = "editor_seams/cases.rs"]
mod cases;
use cases::{Mode, Seam, CASES};

/// Runs the case's input, applying each view change to `view`.
fn run(s: &NativeEditorSession, case: &Seam, view: &mut String) -> EditorViewChange {
    let mut apply = |change: EditorViewChange| {
        let replaced = change.range.start as usize..change.range.end as usize;
        view.replace_range(replaced, &change.inserted);
        change
    };
    let selected = range(case.range.0, case.range.1);
    let text: Vec<u16> = case.text.encode_utf16().collect();
    let runs = || -> Vec<EditorUtf16Replacement> {
        if case.runs.is_empty() {
            return vec![EditorUtf16Replacement {
                range: selected,
                inserted: text.clone(),
            }];
        }
        let run = |&(a, z, text): &(u64, u64, &str)| EditorUtf16Replacement {
            range: range(a, z),
            inserted: text.encode_utf16().collect(),
        };
        case.runs.iter().map(run).collect()
    };
    match case.mode {
        Mode::Typing => apply(
            s.replace_utf16_action(0, selected, text, EditorInputAction::Isolated)
                .unwrap(),
        ),
        Mode::Os => apply(s.replace_os_utf16(0, selected, text, vec![]).unwrap().unwrap()),
        Mode::Commit => {
            for value in ["に", "日本"] {
                let marked = s
                    .compose_utf16(0, selected, value.encode_utf16().collect())
                    .unwrap();
                assert_eq!(marked.text, value);
                assert_eq!(s.source_text().unwrap(), case.source);
                assert_eq!(s.revision().unwrap(), 0);
            }
            s.cancel_composition(0).unwrap();
            assert!(s.composition().unwrap().is_none());
            s.compose_utf16(0, selected, text).unwrap();
            apply(s.commit_composition_utf16(0, None).unwrap().unwrap())
        }
        Mode::MarkedRuns => {
            s.compose_utf16(0, selected, text.clone()).unwrap();
            assert_eq!(s.source_text().unwrap(), case.source);
            let change = s.replace_many_utf16(0, runs()).unwrap();
            assert_eq!(s.revision().unwrap(), 1);
            apply(change)
        }
        Mode::MarkedOs(at) => {
            s.compose_utf16(0, range(at, at), vec![33]).unwrap();
            let change = s.replace_os_utf16(0, selected, text, vec![]).unwrap();
            assert_eq!(s.revision().unwrap(), 1);
            apply(change.unwrap())
        }
        Mode::Runs => apply(s.replace_many_utf16(0, runs()).unwrap()),
        Mode::Sequence(format) => {
            if let Some(format) = format {
                assert!(s.toggle_format(0, format).unwrap().is_none());
            }
            let mut caret = selected;
            let mut last = None;
            for &(isolated, input) in case.inputs {
                let action = if isolated {
                    EditorInputAction::Isolated
                } else {
                    EditorInputAction::Typing
                };
                let revision = s.revision().unwrap();
                let input = input.encode_utf16().collect();
                let change = s
                    .replace_utf16_action(revision, caret, input, action)
                    .unwrap();
                caret = s
                    .display_to_utf16(change.revision, change.selection.clone())
                    .unwrap();
                last = Some(apply(change));
            }
            last.unwrap()
        }
    }
}

/// Source after an authored save: a nonempty note without a final line
/// ending gains its own (portable-core/recovery.md).
fn saved(source: &str) -> String {
    if source.is_empty() || source.ends_with('\n') {
        return source.to_owned();
    }
    let ending = if source.contains("\r\n") { "\r\n" } else { "\n" };
    format!("{source}{ending}")
}

fn shown(source: &str) -> String {
    futo_notes_editor::EditorSession::open(source).display_text()
}

#[test]
fn native_structural_seams_and_raw_composition_keep_exact_saves_and_carets() {
    let mut failed = Vec::new();
    for case in CASES {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        // Exactly these bytes, which may lack a final line ending.
        std::fs::write(tree.path("vault/seam.md"), case.source).unwrap();
        let s = store.open_editor("seam".into()).unwrap();
        let mut view = s.display_text().unwrap();
        assert_eq!(view, shown(case.source), "{}", case.name);
        let change = run(&s, case, &mut view);
        let caret = s
            .display_to_utf16(change.revision, change.selection.clone())
            .unwrap();
        let got = s.source_text().unwrap();
        if got != case.expected || caret != range(case.caret, case.caret) {
            failed.push(format!(
                "{}: {got:?} caret {caret:?}, expected {:?} caret {}",
                case.name, case.expected, case.caret
            ));
            continue;
        }
        let name = case.name;
        assert_eq!(view, shown(case.expected), "{name}: the view is a fresh read");
        for _ in 0..case.history {
            s.undo(s.revision().unwrap()).unwrap().unwrap();
        }
        assert_eq!(s.source_text().unwrap(), case.source, "{name}: undo");
        assert!(s.undo(s.revision().unwrap()).unwrap().is_none(), "{name}");
        let mut redone = None;
        for _ in 0..case.history {
            redone = s.redo(s.revision().unwrap()).unwrap();
        }
        assert_eq!(s.source_text().unwrap(), case.expected, "{name}: redo");
        let caret = case.redo_caret.unwrap_or(case.caret);
        let revision = s.revision().unwrap();
        assert_eq!(
            s.display_to_utf16(revision, redone.unwrap().selection)
                .unwrap(),
            range(caret, caret),
            "{name}: redo caret"
        );
        s.checkpoint().unwrap();
        s.detach().unwrap();
        let saved = saved(case.expected);
        let recovered = store.open_editor("seam".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), saved, "{name}");
        assert_eq!(recovered.display_text().unwrap(), shown(&saved), "{name}");
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("seam".into()).unwrap(), saved, "{name}");
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
