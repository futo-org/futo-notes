use super::super::content;

pub(in crate::session::blocks) fn protect_list_body(raw: &str, task: bool) -> (String, usize) {
    let (mut body, work) = content::protect_content(raw, false, true);
    if let Some(first @ (' ' | '\t')) = body.chars().next() {
        body.replace_range(..first.len_utf8(), &format!("&#{};", first as u32));
    }
    let bytes = body.as_bytes();
    if !task
        && bytes.len() >= 4
        && bytes[0] == b'['
        && matches!(bytes[1], b' ' | b'\t' | b'x' | b'X')
        && bytes[2] == b']'
        && matches!(bytes[3], b' ' | b'\t')
    {
        body.insert(0, '\\');
    }
    (body, work)
}

use super::*;

impl EditorSession {
    pub(super) fn list_command_body(
        &self,
        range: std::ops::Range<usize>,
        command: BlockCommand,
        remove: bool,
    ) -> (Option<String>, usize, usize) {
        let original = self.source.byte_slice(range).to_string();
        let (body, parsed) = if remove {
            content::protect_content(&original, false, true)
        } else {
            protect_list_body(&original, command == BlockCommand::TaskList)
        };
        let copied = original.len() + body.len();
        let same = body.len() == original.len()
            && body.bytes().zip(original.bytes()).all(|(a, b)| {
                crate::inline::visit_container();
                a == b
            });
        // Exact raw no-ops retain complete atoms through the header edit.
        ((!same).then_some(body), parsed, copied)
    }
}
