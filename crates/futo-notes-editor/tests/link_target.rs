use futo_notes_editor::{external_link_url, normalize_link_destination};

#[test]
fn only_an_explicit_allowed_scheme_opens_on_tap() {
    for destination in [
        "https://x",
        "HTTP://X",
        "http://x.test/p",
        "mailto:a@b.c",
        "tel:+15551234",
        "tel:5551234",
        "tel:911",
        "sms:+15551234",
        "  https://x ",
    ] {
        assert_eq!(
            external_link_url(destination).as_deref(),
            Some(destination.trim()),
            "{destination:?}"
        );
    }
}

#[test]
fn an_unsafe_or_missing_scheme_never_opens() {
    for destination in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<b>x</b>",
        "futonotes://x",
        // schemeless: a note link, not a web address, however it looks
        "google.com",
        "www.x.org/p",
        "example.com:8080/a",
        "localhost:3000",
        "setup.sh",
        "main.rs",
        "my.notes",
        "other.md",
        "Other.MD",
        "./a.md",
        "../b",
        "notes/x.md#top",
        "#h",
        "#heading",
        "/abs",
        "Other Note",
        "?q=1",
        "",
        "   ",
        "https://a b",
    ] {
        assert_eq!(external_link_url(destination), None, "{destination:?}");
    }
}

#[test]
fn a_typed_web_address_is_saved_with_https() {
    for (typed, saved) in [
        ("google.com", "https://google.com"),
        ("www.x.org/p", "https://www.x.org/p"),
        ("WWW.Example.org", "https://WWW.Example.org"),
        ("docs.example.co.uk", "https://docs.example.co.uk"),
        (
            "example.com:8080/a?b=1#c",
            "https://example.com:8080/a?b=1#c",
        ),
        ("  google.com ", "https://google.com"),
        ("www.wiki.foo", "https://www.wiki.foo"),
    ] {
        assert_eq!(normalize_link_destination(typed), saved, "{typed:?}");
    }
}

#[test]
fn anything_else_is_saved_as_typed() {
    for typed in [
        "setup.sh",
        "main.rs",
        "script.py",
        "archive.zip",
        "my.notes",
        "Project.Alpha",
        "v1.2",
        "notes/a.md",
        "other.md",
        "www.example.com/readme.md",
        "docs.example.com/readme.md",
        "../b",
        "./a",
        "#h",
        "/abs.com",
        "Other Note",
        "a b.com",
        "https://x",
        "mailto:a@b.c",
        "tel:911",
        "javascript:alert(1)",
        "user@example.com",
        "localhost:3000",
        "",
        "  ",
    ] {
        assert_eq!(normalize_link_destination(typed), typed, "{typed:?}");
    }
}

#[test]
fn non_ascii_and_odd_input_never_panics() {
    for typed in [
        "bücher.de",
        "例え.テスト",
        "example.рф",
        "例え.com/パス",
        "💥.com",
        "a\u{0}b.com",
        "é",
        ":",
        "::",
        "http:",
        "%",
        "a.b.c.d.e",
        ".com",
        "com.",
        "..",
        "\u{202e}google.com",
        "ünï.cöm:80/é?ü#ö",
    ] {
        let _ = external_link_url(typed);
        let _ = normalize_link_destination(typed);
    }
    // A non-ASCII host on a known TLD is a web address; the system punycodes it.
    assert_eq!(normalize_link_destination("bücher.de"), "https://bücher.de");
    // A non-ASCII TLD is not on the list, so it stays as typed.
    assert_eq!(normalize_link_destination("例え.テスト"), "例え.テスト");
    assert_eq!(external_link_url("bücher.de"), None);
}
