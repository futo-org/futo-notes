use super::*;

/// A clean, unfocused editor sitting on a note nothing has touched. Each
/// test perturbs exactly the facts it is about.
fn facts() -> OpenNoteFacts {
    OpenNoteFacts {
        base: "base".to_owned(),
        draft: "base".to_owned(),
        disk: Some("base".to_owned()),
        renamed_to: None,
        editor_focused: false,
        edited_during_cycle: false,
    }
}

fn keep_draft(base: &str, reason: KeepDraftReason) -> OpenNoteDisposition {
    OpenNoteDisposition::KeepDraft {
        base: base.to_owned(),
        reason,
    }
}

mod invariants;
mod verdict_table;
