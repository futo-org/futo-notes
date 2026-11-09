use futo_notes_editor::external_link_url;

#[test]
fn a_bare_domain_opens_as_https() {
    for (destination, opens) in [
        ("google.com", "https://google.com"),
        ("www.x.org/p", "https://www.x.org/p"),
        (
            "example.com:8080/a?b=1#c",
            "https://example.com:8080/a?b=1#c",
        ),
        ("docs.example.co.uk", "https://docs.example.co.uk"),
        ("  google.com ", "https://google.com"),
    ] {
        assert_eq!(external_link_url(destination).as_deref(), Some(opens));
    }
}

#[test]
fn a_destination_with_a_scheme_is_external_as_written() {
    for destination in [
        "https://x",
        "http://x.test/p",
        "mailto:a@b.c",
        "tel:+15551234",
    ] {
        assert_eq!(external_link_url(destination).as_deref(), Some(destination));
    }
}

#[test]
fn a_note_path_or_relative_destination_is_never_a_web_address() {
    for destination in [
        "other.md",
        "Other.MD",
        "./a.md",
        "../b",
        "notes/x.md",
        "notes/x.md#top",
        "docs.example.com/readme.md",
        "#heading",
        "/abs",
        "/abs.com",
        "Other Note",
        "Other",
        "notes/meeting",
        "scan.pdf",
        "v1.2",
        "?q=1",
        "",
        "   ",
    ] {
        assert_eq!(external_link_url(destination), None, "{destination:?}");
    }
}
