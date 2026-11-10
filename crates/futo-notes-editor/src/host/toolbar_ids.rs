use crate::{InlineFormat, ToolbarList, ToolbarState};

/// The toolbar manifest ids (packages/editor/src/toolbar.ts) to light and to dim for one
/// engine selection state. A name map over engine facts: no rule lives here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolbarHighlights {
    pub active: Vec<&'static str>,
    pub disabled: Vec<&'static str>,
}

pub fn toolbar_highlights(state: &ToolbarState) -> ToolbarHighlights {
    let mut active = Vec::new();
    for (format, id) in [
        (InlineFormat::Bold, "bold"),
        (InlineFormat::Italic, "italic"),
        (InlineFormat::Strike, "strikethrough"),
    ] {
        if state.formats.contains(&format) {
            active.push(id);
        }
    }
    if state.code {
        active.push("code-block");
    } else if let Some(level @ 1..=3) = state.heading {
        active.push(["heading-1", "heading-2", "heading-3"][usize::from(level) - 1]);
    } else if !state.mixed
        && !matches!(state.heading, Some(4..=6))
        && state.list.is_none()
        && !state.quote
    {
        // `heading` is 0 for a paragraph. A level 4-6 heading has no control and is not a
        // paragraph, so it lights no block item.
        active.push("paragraph");
    }
    if state.quote {
        active.push("quote");
    }
    match state.list {
        Some(ToolbarList::Bullet) => active.push("bullet-list"),
        Some(ToolbarList::Ordered) => active.push("ordered-list"),
        Some(ToolbarList::Task) => active.push("task-list"),
        None => {}
    }
    let mut disabled = Vec::new();
    if !state.inline_allowed {
        disabled.extend(["bold", "italic", "strikethrough", "link"]);
    }
    for (off, id) in [
        (!state.can_indent, "indent"),
        (!state.can_outdent, "outdent"),
        (!state.can_undo, "undo"),
        (!state.can_redo, "redo"),
    ] {
        if off {
            disabled.push(id);
        }
    }
    ToolbarHighlights { active, disabled }
}
