use super::*;
use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range, ParagraphKey};
fn utf16(a: usize, z: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(z),
    }
}

#[test]
fn paragraph_edits_checkpoint_reopen_and_recover_exact_untouched_line_endings() {
    for opening in [
        "__ab__\r\nuntouched  \r\n",
        "__ab__\r\nuntouched  ",
        "__ab__\nuntouched\r\n\r\n",
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "lines", opening).unwrap();
        let expected = opening.replacen("__ab__", "__a\nb__", 1);
        {
            let mut editor = store.open_editor("lines").unwrap();
            editor
                .paragraph_key_utf16(Revision(0), utf16(1, 1), ParagraphKey::Enter)
                .unwrap()
                .unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(store.read("lines").unwrap(), opening);
            editor.flush_recovery().unwrap();
        }
        let mut recovered = store.open_editor("lines").unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), expected.replace("__", ""));
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered
            .paragraph_key_utf16(recovered.revision(), utf16(2, 2), ParagraphKey::Backspace)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.source_text(), opening);
        recovered.undo(recovered.revision()).unwrap().unwrap();
        assert_eq!(recovered.source_text(), expected);
        let checkpoint = recovered.checkpoint().unwrap();
        assert_eq!(checkpoint.disposition, FlushDisposition::Wrote);
        assert_eq!(
            checkpoint.mutation.unwrap().final_id.as_deref(),
            Some("lines")
        );
        assert_eq!(store.read("lines").unwrap(), expected);
        drop(recovered);
        let reopened = store.open_editor("lines").unwrap();
        assert_eq!(reopened.source_text(), expected);
        assert_eq!(reopened.display_text(), expected.replace("__", ""));
    }
}
