//! One nested marked/derived reference story reaches the real final Store gate.
use super::*;
use futo_notes_editor::{
    Affinity, DisplayUtf16Offset, DisplayUtf16Range, EditorSession, InputAction, ParagraphKey,
};
use std::sync::atomic::{AtomicU64, Ordering};

struct Clock(AtomicU64);
impl RecoveryClock for Clock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

#[test]
fn marked_derived_reference_retry_keeps_both_stacks_and_the_live_foreign_seed() {
    const ORIGINAL: &str = "> __head__\n> pre&acE;fix\n> [id]: /target 'T'\n> ===\n\n[one][id]\n\n";
    const TYPED: &str = "<www.x.test/path";
    // The two marking branches share the final acceptance owner. Pair the two
    // actual storage faults rather than multiplying this story into a matrix.
    for (fault, marked_head) in [
        (storage::Fault::Append, "HEAD"),
        (storage::Fault::ShortWrite, "head"),
    ] {
        let original = format!("{ORIGINAL}{TYPED}");
        let committed = original.replacen("__head__", &format!("__{marked_head}__"), 1);
        let entered = format!("> __{marked_head}__\n> pre&acE;fix\n> ===\n> \n> \\[id]: /target 'T'\n\n[one][id]\n\n{TYPED}");
        // Only the three selected label letters gain a link. The surrounding
        // unresolved brackets and suffix remain literal user text.
        let changed = entered.replace("[one][id]", "[[one](</next>)][id]");
        let canonical = EditorSession::open(&entered);
        let expected_display = format!(
            "{marked_head}\npre\u{223e}\u{333}fix\n\n[id]: /target 'T'\n\n[one][id]\n\n{TYPED}"
        );
        assert_eq!(canonical.display_text(), expected_display);
        assert!(canonical
            .project(Revision(0), range(0, expected_display.len()))
            .unwrap()
            .links
            .is_empty());
        let linked = EditorSession::open(&changed);
        assert_eq!(linked.display_text(), expected_display);
        let selected = expected_display.find("[one][id]").unwrap() + 1;
        assert_eq!(
            linked
                .inspect_link(Revision(0), range(selected, selected + 3))
                .unwrap()
                .unwrap()
                .destination,
            "/next"
        );
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "compound-derived", ORIGINAL).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let clock = Arc::new(Clock(AtomicU64::new(0)));
        let options = || RecoveryOptions {
            clock: clock.clone(),
            ..storage::options(&disk)
        };
        let mut editor = store
            .open_editor_with_recovery("compound-derived", options())
            .unwrap();
        let tail = editor.display_text().len();
        editor
            .replace(Revision(0), range(tail, tail), TYPED)
            .unwrap();
        assert_eq!(editor.source_text(), original);
        let end = editor.display_text().len();
        editor
            .replace_action(
                editor.revision(),
                range(end, end),
                "!",
                InputAction::Isolated,
            )
            .unwrap();
        editor.undo(editor.revision()).unwrap().unwrap();
        let native = DisplayUtf16Range {
            start: DisplayUtf16Offset(13),
            end: DisplayUtf16Offset(13),
        };
        editor
            .select_with_affinity(editor.revision(), range(11, 11), Affinity::Backward)
            .unwrap();
        let marked = editor
            .compose(editor.revision(), range(0, 4), marked_head)
            .unwrap();
        let revision = editor.revision();
        let selection = editor.selection();
        let formats = editor.active_formats();
        let projection = editor.project(revision, range(0, end)).unwrap();
        let prefix = disk.lock().unwrap().accepted.clone();
        let callbacks = Arc::new(Mutex::new(Vec::new()));
        let observed = callbacks.clone();
        editor.set_append_hook(Box::new(move |after| observed.lock().unwrap().push(after)));
        // Crossing the ordinary grouping threshold cannot turn this failed
        // compound into accepted history, or collapse its later command group.
        clock.0.store(500, Ordering::SeqCst);
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.paragraph_key_utf16(revision, native, ParagraphKey::Enter),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(*callbacks.lock().unwrap(), [false]);
        assert_eq!(editor.source_text(), original);
        assert_eq!(editor.display_text().len(), end);
        assert_eq!(editor.revision(), revision);
        assert_eq!(editor.selection(), selection);
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.composition(), Some(marked));
        assert_eq!(editor.project(revision, range(0, end)).unwrap(), projection);
        assert!(editor
            .inspect_link(revision, range(tail + 1, tail + 2))
            .unwrap()
            .is_none());
        assert_eq!(store.read("compound-derived").unwrap(), ORIGINAL);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        assert_eq!(disk.lock().unwrap().accepted, prefix);
        // Actual replay proves the future survived refusal, rather than merely
        // checking the current source. Restore the same mark for the retry.
        editor.cancel_composition(editor.revision()).unwrap();
        editor.redo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), format!("{original}!"));
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), original);
        editor
            .select_with_affinity(editor.revision(), selection, Affinity::Backward)
            .unwrap();
        editor
            .compose(editor.revision(), range(0, 4), marked_head)
            .unwrap();
        callbacks.lock().unwrap().clear();
        let records = disk
            .lock()
            .unwrap()
            .accepted
            .values()
            .map(|bytes| bytes.iter().filter(|&&b| b == b'\n').count())
            .sum::<usize>();
        let revision = editor.revision();
        let change = editor
            .paragraph_key_utf16(revision, native, ParagraphKey::Enter)
            .unwrap()
            .unwrap();
        assert_eq!(*callbacks.lock().unwrap(), [false, true]);
        assert_eq!(change.previous_revision, revision);
        assert_eq!(change.revision, Revision(revision.0 + 1));
        let after_records = disk
            .lock()
            .unwrap()
            .accepted
            .values()
            .map(|bytes| bytes.iter().filter(|&&b| b == b'\n').count())
            .sum::<usize>();
        assert_eq!(
            after_records,
            records + 1,
            "one complete final recovery record"
        );
        assert_eq!(editor.source_text(), entered);
        assert_eq!(editor.display_text(), expected_display);
        assert!(editor.composition().is_none());
        let one = editor.display_text().find("[one][id]").unwrap() + 1;
        assert!(editor
            .inspect_link(editor.revision(), range(one, one + 3))
            .unwrap()
            .is_none());
        // This later reference-dependent operation must see the final repaired
        // parent, while the unrelated actual Typing seed remains owned.
        editor
            .set_link(editor.revision(), range(one, one + 3), "/next")
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), changed);
        assert_eq!(
            editor
                .inspect_link(editor.revision(), range(one, one + 1))
                .unwrap()
                .unwrap()
                .destination,
            "/next"
        );
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), entered);
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), committed);
        if marked_head != "head" {
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), original);
        }
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(
            editor.source_text(),
            ORIGINAL,
            "unchanged marking must not add an empty history group"
        );
        assert!(editor.undo(editor.revision()).unwrap().is_none());
        editor.redo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), original);
        if marked_head != "head" {
            editor.redo(editor.revision()).unwrap().unwrap();
        }
        assert_eq!(editor.source_text(), committed);
        editor.redo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), entered);
        editor.redo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), changed);
        let at = editor.display_text().len();
        editor
            .replace(editor.revision(), range(at, at), ">")
            .unwrap();
        let fresh = EditorSession::open(&editor.source_text());
        let word = fresh.display_text().find("www.x.test/path").unwrap();
        assert_eq!(
            fresh
                .inspect_link(Revision(0), range(word, word + 1))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
        editor
            .replace(editor.revision(), range(at + 1, at + 1), " ")
            .unwrap();
        let saved = editor.source_text();
        let shown = editor.display_text();
        let word = shown.find("www.x.test/path").unwrap();
        assert_eq!(
            editor
                .inspect_link(editor.revision(), range(word, word + 1))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
        editor.flush_recovery().unwrap();
        drop(editor);
        disk.lock().unwrap().power_loss();
        let mut recovered = store
            .open_editor_with_recovery("compound-derived", options())
            .unwrap();
        assert_eq!(recovered.source_text(), saved);
        assert_eq!(recovered.display_text(), shown);
        assert_eq!(
            recovered
                .inspect_link(recovered.revision(), range(word, word + 1))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("compound-derived").unwrap(), saved);
    }
}
