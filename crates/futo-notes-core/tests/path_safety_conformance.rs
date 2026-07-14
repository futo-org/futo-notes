use futo_notes_core::files::ensure_safe_note_id;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<PathCase>,
}

#[derive(Deserialize)]
struct PathCase {
    id: String,
    valid: bool,
}

#[test]
fn safe_note_ids_match_the_shared_boundary_corpus() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../../tests/conformance/path-safety.json"))
            .expect("parse path-safety fixture");

    for case in fixture.cases {
        assert_eq!(
            ensure_safe_note_id(&case.id).is_ok(),
            case.valid,
            "unexpected Rust path-safety result for {:?}",
            case.id
        );
    }
}
