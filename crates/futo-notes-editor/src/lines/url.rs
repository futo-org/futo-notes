//! The GFM autolink literal grammar as markdown-rs 1.0 tokenizes it, over raw
//! source bytes. Every read is bounds-checked, so no input can panic.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// `www.` (the destination gains `http://`).
    Www,
    /// `http://` or `https://`.
    Protocol,
    /// A bare address (the destination gains `mailto:`).
    Email,
    /// `mailto:` or `xmpp:` before an address.
    Prefixed,
}

impl Kind {
    pub(crate) fn prefix(self) -> &'static str {
        match self {
            Self::Www => "http://",
            Self::Email => "mailto:",
            Self::Protocol | Self::Prefixed => "",
        }
    }
}

#[derive(PartialEq)]
enum Class {
    Whitespace,
    Punctuation,
    Other,
}

/// Inline content of one block. Bytes at or past `end` read as its end,
/// which markdown-rs classifies as whitespace.
pub(crate) struct Content<'a> {
    pub text: &'a str,
    pub end: usize,
}

const TRAILING: &[u8] = b"!\"')*,.:;?_~";

impl Content<'_> {
    fn byte(&self, at: usize) -> Option<u8> {
        if at < self.end {
            self.text.as_bytes().get(at).copied()
        } else {
            None
        }
    }

    fn class(&self, at: usize) -> Class {
        let Some(byte) = self.byte(at) else {
            return Class::Whitespace;
        };
        if byte.is_ascii_whitespace() {
            Class::Whitespace
        } else if byte.is_ascii_punctuation() {
            Class::Punctuation
        } else if byte.is_ascii_alphanumeric() {
            Class::Other
        } else {
            match self.text.get(at..).and_then(|rest| rest.chars().next()) {
                Some(char) if char.is_whitespace() => Class::Whitespace,
                Some(char) if !char.is_ascii() && punctuation(char) => Class::Punctuation,
                _ => Class::Other,
            }
        }
    }

    /// Whether trailing punctuation at `at` ends the literal.
    fn trail(&self, mut at: usize) -> bool {
        loop {
            match self.byte(at) {
                Some(byte) if TRAILING.contains(&byte) => at += 1,
                // `&name;` as a whole is trailing punctuation.
                Some(b'&') => {
                    at += 1;
                    if !self.byte(at).is_some_and(|byte| byte.is_ascii_alphabetic()) {
                        return false;
                    }
                    while self.byte(at).is_some_and(|byte| byte.is_ascii_alphabetic()) {
                        at += 1;
                    }
                    if self.byte(at) != Some(b';') {
                        return false;
                    }
                    at += 1;
                }
                Some(b'<') => return true,
                Some(b']') => {
                    at += 1;
                    if matches!(
                        self.byte(at),
                        None | Some(b'\t' | b'\n' | b' ' | b'(' | b'[')
                    ) {
                        return true;
                    }
                }
                _ => return self.class(at) == Class::Whitespace,
            }
        }
    }

    /// The domain's end, if it holds a non-punctuation character and no `_`
    /// in its last two segments.
    fn domain(&self, mut at: usize) -> Option<usize> {
        let (mut seen, mut last, mut penultimate) = (false, false, false);
        loop {
            match self.byte(at) {
                Some(byte @ (b'.' | b'_')) => {
                    if self.trail(at) {
                        break;
                    }
                    if byte == b'_' {
                        last = true;
                    } else {
                        penultimate = last;
                        last = false;
                    }
                    at += 1;
                }
                Some(b'-' | 0x80..=0xBF) => at += 1,
                _ if self.class(at) == Class::Other => {
                    seen = true;
                    at += 1;
                }
                _ => break,
            }
        }
        (seen && !last && !penultimate).then_some(at)
    }

    /// The path's end, balancing parentheses against a trailing `)`.
    fn path(&self, mut at: usize) -> usize {
        let (mut open, mut close) = (0usize, 0usize);
        loop {
            match self.byte(at) {
                Some(0x80..=0xBF) => at += 1,
                Some(b'(') => {
                    open += 1;
                    at += 1;
                }
                Some(
                    byte @ (b'!' | b'"' | b'&' | b'\'' | b')' | b'*' | b',' | b'.' | b':' | b';'
                    | b'<' | b'?' | b']' | b'_' | b'~'),
                ) => {
                    let unbalanced = byte == b')' && close < open;
                    if !unbalanced && self.trail(at) {
                        break;
                    }
                    close += usize::from(byte == b')');
                    at += 1;
                }
                None => break,
                _ if self.class(at) == Class::Whitespace => break,
                _ => at += 1,
            }
        }
        at
    }

    /// A `www.` or `http(s)://` literal starting at `at`, after the byte
    /// `previous` (`None` at the start of a line).
    pub(crate) fn literal(&self, at: usize, previous: Option<u8>) -> Option<(usize, Kind)> {
        match self.byte(at)? {
            b'w' | b'W'
                if matches!(
                    previous,
                    None | Some(b'\t' | b'\n' | b' ' | b'(' | b'*' | b'_' | b'[' | b']' | b'~')
                ) =>
            {
                let prefix = (0..3).all(|i| matches!(self.byte(at + i), Some(b'w' | b'W')));
                // `www.` must be followed by something; it joins the domain.
                if !prefix || self.byte(at + 3) != Some(b'.') || self.byte(at + 4).is_none() {
                    return None;
                }
                Some((self.path(self.domain(at)?), Kind::Www))
            }
            b'h' | b'H' if !previous.is_some_and(|byte| byte.is_ascii_alphabetic()) => {
                let mut colon = at;
                while self
                    .byte(colon)
                    .is_some_and(|byte| byte.is_ascii_alphabetic())
                {
                    if colon - at == 5 {
                        return None;
                    }
                    colon += 1;
                }
                let scheme = self.text.get(at..colon)?.to_ascii_lowercase();
                let slashes = (1..3).all(|i| self.byte(colon + i) == Some(b'/'));
                if self.byte(colon) != Some(b':')
                    || !(scheme == "http" || scheme == "https")
                    || !slashes
                {
                    return None;
                }
                Some((self.path(self.domain(colon + 3)?), Kind::Protocol))
            }
            _ => None,
        }
    }
}

/// Unicode punctuation or symbol (CommonMark 0.31). Without the general
/// category in std, this treats non-alphanumerics outside the combining and
/// format ranges as punctuation. It only decides where a domain ends.
fn punctuation(char: char) -> bool {
    !(char.is_alphanumeric()
        || matches!(char,
            '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2060}'..='\u{2064}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FE20}'..='\u{FE2F}'
            | '\u{E000}'..='\u{F8FF}'))
}

/// Email literals in one run of plain text (markdown-rs's data token), as
/// ranges relative to `data`.
pub(crate) fn emails(data: &[u8], found: &mut Vec<(usize, usize, Kind)>) {
    let mut at = 0;
    let mut min = 0;
    while at < data.len() {
        if data[at] == b'@' {
            if let Some((start, end, kind)) = email(data, min, at) {
                found.push((start, end, kind));
                min = end;
                at = end;
            }
        }
        at += 1;
    }
}

fn email(data: &[u8], min: usize, at: usize) -> Option<(usize, usize, Kind)> {
    let atext =
        |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.' | b'_');
    let mut start = at;
    while start > min && atext(data[start - 1]) {
        start -= 1;
    }
    if start == at || (start > min && data[start - 1] == b'/') {
        return None;
    }
    // A `mailto:` or `xmpp:` scheme joins the literal.
    let mut kind = Kind::Email;
    let mut xmpp = false;
    if start > min && data[start - 1] == b':' {
        let mut scheme = start - 1;
        while scheme > min && data[scheme - 1].is_ascii_alphanumeric() {
            scheme -= 1;
        }
        let name = data[scheme..start - 1].to_ascii_lowercase();
        if name == b"mailto" || name == b"xmpp" {
            xmpp = name == b"xmpp";
            kind = Kind::Prefixed;
            start = scheme;
        }
    }
    let mut end = at + 1;
    let mut dot = false;
    while let Some(&byte) = data.get(end) {
        match byte {
            b'-' | b'_' => {}
            b'/' if xmpp => {}
            b'.' if data.get(end + 1).is_some_and(u8::is_ascii_alphanumeric) => dot = true,
            _ if byte.is_ascii_alphanumeric() => {}
            _ => break,
        }
        end += 1;
    }
    let last = data[end - 1];
    (end > at + 1 && dot && (last == b'.' || last.is_ascii_alphabetic()))
        .then_some((start, end, kind))
}
