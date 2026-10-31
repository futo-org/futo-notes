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
