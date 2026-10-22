//! The keyboard a key is described against: a US layout's characters, the named keys,
//! and the number each platform knows each physical key by.

/// A US keyboard: each unshifted character, the character Shift turns it into, and its key.
pub(super) const US_KEYS: [(char, char, &str); 48] = [
    ('a', 'A', "KeyA"),
    ('b', 'B', "KeyB"),
    ('c', 'C', "KeyC"),
    ('d', 'D', "KeyD"),
    ('e', 'E', "KeyE"),
    ('f', 'F', "KeyF"),
    ('g', 'G', "KeyG"),
    ('h', 'H', "KeyH"),
    ('i', 'I', "KeyI"),
    ('j', 'J', "KeyJ"),
    ('k', 'K', "KeyK"),
    ('l', 'L', "KeyL"),
    ('m', 'M', "KeyM"),
    ('n', 'N', "KeyN"),
    ('o', 'O', "KeyO"),
    ('p', 'P', "KeyP"),
    ('q', 'Q', "KeyQ"),
    ('r', 'R', "KeyR"),
    ('s', 'S', "KeyS"),
    ('t', 'T', "KeyT"),
    ('u', 'U', "KeyU"),
    ('v', 'V', "KeyV"),
    ('w', 'W', "KeyW"),
    ('x', 'X', "KeyX"),
    ('y', 'Y', "KeyY"),
    ('z', 'Z', "KeyZ"),
    ('1', '!', "Digit1"),
    ('2', '@', "Digit2"),
    ('3', '#', "Digit3"),
    ('4', '$', "Digit4"),
    ('5', '%', "Digit5"),
    ('6', '^', "Digit6"),
    ('7', '&', "Digit7"),
    ('8', '*', "Digit8"),
    ('9', '(', "Digit9"),
    ('0', ')', "Digit0"),
    ('-', '_', "Minus"),
    ('=', '+', "Equal"),
    ('[', '{', "BracketLeft"),
    (']', '}', "BracketRight"),
    ('\\', '|', "Backslash"),
    (';', ':', "Semicolon"),
    ('\'', '"', "Quote"),
    (',', '<', "Comma"),
    ('.', '>', "Period"),
    ('/', '?', "Slash"),
    ('`', '~', "Backquote"),
    (' ', ' ', "Space"),
];

/// The named keys (`key` and `code` are the same), with the character AppKit gives each
/// (the private-use function-key characters for the arrows and the navigation block) and
/// its GDK keyval.
pub(super) const NAMED: [(&str, char, u32); 25] = [
    ("Enter", '\r', 0xff0d),
    ("Tab", '\t', 0xff09),
    ("Backspace", '\u{7f}', 0xff08),
    ("Delete", '\u{f728}', 0xffff),
    ("Escape", '\u{1b}', 0xff1b),
    ("Home", '\u{f729}', 0xff50),
    ("End", '\u{f72b}', 0xff57),
    ("PageUp", '\u{f72c}', 0xff55),
    ("PageDown", '\u{f72d}', 0xff56),
    ("ArrowLeft", '\u{f702}', 0xff51),
    ("ArrowRight", '\u{f703}', 0xff53),
    ("ArrowDown", '\u{f701}', 0xff54),
    ("ArrowUp", '\u{f700}', 0xff52),
    ("F1", '\u{f704}', 0xffbe),
    ("F2", '\u{f705}', 0xffbf),
    ("F3", '\u{f706}', 0xffc0),
    ("F4", '\u{f707}', 0xffc1),
    ("F5", '\u{f708}', 0xffc2),
    ("F6", '\u{f709}', 0xffc3),
    ("F7", '\u{f70a}', 0xffc4),
    ("F8", '\u{f70b}', 0xffc5),
    ("F9", '\u{f70c}', 0xffc6),
    ("F10", '\u{f70d}', 0xffc7),
    ("F11", '\u{f70e}', 0xffc8),
    ("F12", '\u{f70f}', 0xffc9),
];

/// GDK's keyval for Shift+Tab: GTK reports it as a key of its own.
#[cfg(any(target_os = "linux", test))]
pub(super) const ISO_LEFT_TAB: u32 = 0xfe20;

/// Each physical key, by its `code`, and the number each platform knows it by: the macOS
/// virtual key code, the X11/evdev keycode a `GdkEventKey` carries (WebKitGTK reads
/// `code` from it), and the Windows virtual-key code (DevTools' `windowsVirtualKeyCode`).
const PHYSICAL_KEYS: [(&str, u16, u16, u16); 73] = [
    ("KeyA", 0, 38, 0x41),
    ("KeyB", 11, 56, 0x42),
    ("KeyC", 8, 54, 0x43),
    ("KeyD", 2, 40, 0x44),
    ("KeyE", 14, 26, 0x45),
    ("KeyF", 3, 41, 0x46),
    ("KeyG", 5, 42, 0x47),
    ("KeyH", 4, 43, 0x48),
    ("KeyI", 34, 31, 0x49),
    ("KeyJ", 38, 44, 0x4a),
    ("KeyK", 40, 45, 0x4b),
    ("KeyL", 37, 46, 0x4c),
    ("KeyM", 46, 58, 0x4d),
    ("KeyN", 45, 57, 0x4e),
    ("KeyO", 31, 32, 0x4f),
    ("KeyP", 35, 33, 0x50),
    ("KeyQ", 12, 24, 0x51),
    ("KeyR", 15, 27, 0x52),
    ("KeyS", 1, 39, 0x53),
    ("KeyT", 17, 28, 0x54),
    ("KeyU", 32, 30, 0x55),
    ("KeyV", 9, 55, 0x56),
    ("KeyW", 13, 25, 0x57),
    ("KeyX", 7, 53, 0x58),
    ("KeyY", 16, 29, 0x59),
    ("KeyZ", 6, 52, 0x5a),
    ("Digit1", 18, 10, 0x31),
    ("Digit2", 19, 11, 0x32),
    ("Digit3", 20, 12, 0x33),
    ("Digit4", 21, 13, 0x34),
    ("Digit5", 23, 14, 0x35),
    ("Digit6", 22, 15, 0x36),
    ("Digit7", 26, 16, 0x37),
    ("Digit8", 28, 17, 0x38),
    ("Digit9", 25, 18, 0x39),
    ("Digit0", 29, 19, 0x30),
    ("Minus", 27, 20, 0xbd),
    ("Equal", 24, 21, 0xbb),
    ("BracketLeft", 33, 34, 0xdb),
    ("BracketRight", 30, 35, 0xdd),
    ("Backslash", 42, 51, 0xdc),
    ("Semicolon", 41, 47, 0xba),
    ("Quote", 39, 48, 0xde),
    ("Comma", 43, 59, 0xbc),
    ("Period", 47, 60, 0xbe),
    ("Slash", 44, 61, 0xbf),
    ("Backquote", 50, 49, 0xc0),
    ("Space", 49, 65, 0x20),
    ("Enter", 36, 36, 0x0d),
    ("Tab", 48, 23, 0x09),
    ("Backspace", 51, 22, 0x08),
    ("Delete", 117, 119, 0x2e),
    ("Escape", 53, 9, 0x1b),
    ("Home", 115, 110, 0x24),
    ("End", 119, 115, 0x23),
    ("PageUp", 116, 112, 0x21),
    ("PageDown", 121, 117, 0x22),
    ("ArrowLeft", 123, 113, 0x25),
    ("ArrowRight", 124, 114, 0x27),
    ("ArrowDown", 125, 116, 0x28),
    ("ArrowUp", 126, 111, 0x26),
    ("F1", 122, 67, 0x70),
    ("F2", 120, 68, 0x71),
    ("F3", 99, 69, 0x72),
    ("F4", 118, 70, 0x73),
    ("F5", 96, 71, 0x74),
    ("F6", 97, 72, 0x75),
    ("F7", 98, 73, 0x76),
    ("F8", 100, 74, 0x77),
    ("F9", 101, 75, 0x78),
    ("F10", 109, 76, 0x79),
    ("F11", 103, 95, 0x7a),
    ("F12", 111, 96, 0x7b),
];

pub(super) fn physical(code: &str) -> Option<(u16, u16, u16)> {
    PHYSICAL_KEYS
        .iter()
        .find(|(name, ..)| *name == code)
        .map(|(_, mac, x11, windows)| (*mac, *x11, *windows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_a_request_can_name_has_a_number_on_every_platform() {
        for (_, _, code) in US_KEYS {
            assert!(physical(code).is_some(), "{code}");
        }
        for (name, ..) in NAMED {
            assert!(physical(name).is_some(), "{name}");
        }
        assert_eq!(PHYSICAL_KEYS.len(), US_KEYS.len() + NAMED.len());
    }
}
