use crate::lines::{block, Carry, Line};

/// `prefix` then `text`, with a `\` written into `text` when without it the
/// line would not read as `keeps` wants, after `carry`. Removing the bullet
/// from `- # todo` keeps a plain line by writing `\# todo`. Nothing is
/// escaped when the line already reads as wanted, or when no `\` helps.
pub(crate) fn kept_line(
    carry: &Carry,
    prefix: &str,
    text: &str,
    keeps: impl Fn(&Line) -> bool,
) -> String {
    let read = |line: &str| {
        let mut carry = carry.clone();
        carry.first = false;
        block::read_line(&mut carry, line, 0)
    };
    let plain = format!("{prefix}{text}");
    if keeps(&read(&plain)) {
        return plain;
    }
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let rest = &text[lead..];
    let at = match rest.bytes().next() {
        Some(b) if b.is_ascii_punctuation() => Some(lead),
        Some(b) if b.is_ascii_digit() => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            matches!(rest.as_bytes().get(digits), Some(b'.' | b')')).then_some(lead + digits)
        }
        _ => None,
    };
    if let Some(at) = at {
        let escaped = format!("{prefix}{}\\{}", &text[..at], &text[at..]);
        if keeps(&read(&escaped)) {
            return escaped;
        }
    }
    plain
}
