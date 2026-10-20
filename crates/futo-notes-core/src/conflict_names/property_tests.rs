use proptest::prelude::*;

use super::*;

const CONFLICT_OPEN: &str = " (conflict ";
const NAMING_ROUNDS: usize = 6;

fn conflict_open_count(name: &str) -> usize {
    name.matches(CONFLICT_OPEN).count()
}

fn date_token() -> impl Strategy<Value = String> {
    (2000u32..2100, 1u32..13, 1u32..29)
        .prop_map(|(year, month, day)| format!("{year:04}-{month:02}-{day:02}"))
}

fn object_id() -> impl Strategy<Value = String> {
    prop_oneof![
        "[0-9a-f]{8,16}",
        "[0-9a-zA-Z]{1,7}",
        "[0-9a-zA-Z]{8,16}",
        "[0-9a-f]{8}-[0-9a-f]{4}",
        "-{1,4}",
    ]
}

/// The object-id shape the sync server actually issues: a UUID, whose first
/// eight alphanumeric characters are always hex digits.
fn uuid_object_id() -> impl Strategy<Value = String> {
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
}

/// Filenames a vault can actually hold, weighted toward the shapes that
/// stress the suffix peeler: plain notes, non-`.md` attachments, names that
/// are already parked copies (possibly with an empty stem), and user titles
/// that merely mention the word "conflict".
fn vault_filename() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9 ]{1,12}\\.md",
        "[a-z0-9 ]{1,12}",
        "[a-z0-9 ]{1,8}\\.(png|txt|jpeg)",
        (prop::option::of("[a-z0-9 ]{1,8}"), date_token())
            .prop_map(|(stem, date)| format!("{} (conflict {date}).md", stem.unwrap_or_default())),
        (prop::option::of("[a-z0-9 ]{1,8}"), "[0-9a-f]{8}").prop_map(|(stem, short)| format!(
            "{} (conflict {short}).md",
            stem.unwrap_or_default()
        )),
        "[a-z0-9 ]{1,8} \\(conflict resolution\\)\\.md",
        "[a-z0-9 ]{1,8}( \\(conflict [0-9a-f]{8}\\)){2,3}\\.md",
    ]
}

/// The same filename shapes, forced to markdown by appending the extension
/// rather than rejecting the non-`.md` arms — a `prop_assume!` here trips
/// proptest's global reject cap once the case count is raised.
fn markdown_vault_filename() -> impl Strategy<Value = String> {
    vault_filename().prop_map(|name| {
        if name.ends_with(".md") {
            name
        } else {
            format!("{name}.md")
        }
    })
}

proptest! {
    #[test]
    fn dated_naming_is_a_fixed_point(name in vault_filename(), date in date_token()) {
        let once = conflict_filename(&name, &date, &HashSet::new());
        prop_assert_eq!(conflict_filename(&once, &date, &HashSet::new()), once);
    }

    #[test]
    fn collision_naming_is_a_fixed_point_for_server_object_ids(
        name in vault_filename(),
        id in uuid_object_id(),
    ) {
        let once = collision_conflict_filename(&name, &id);
        prop_assert_eq!(collision_conflict_filename(&once, &id), once);
    }

    /// Nonstandard short IDs use an explicit `object-` namespace, keeping the
    /// suffix recognizable if the server ever changes object-id shape.
    #[test]
    fn collision_naming_is_a_fixed_point(name in vault_filename(), id in object_id()) {
        let once = collision_conflict_filename(&name, &id);
        prop_assert_eq!(collision_conflict_filename(&once, &id), once);
    }

    /// Re-parking an already-parked copy peels the old suffix instead of
    /// stacking a new one, so the suffix count stops growing after the first
    /// round no matter how many times (or with which dates) it repeats.
    #[test]
    fn repeated_dated_naming_never_stacks_another_suffix(
        name in vault_filename(),
        dates in prop::collection::vec(date_token(), NAMING_ROUNDS),
    ) {
        let mut current = conflict_filename(&name, &dates[0], &HashSet::new());
        let expected_openings = conflict_open_count(&current);
        for date in &dates[1..] {
            current = conflict_filename(&current, date, &HashSet::new());
            prop_assert_eq!(
                conflict_open_count(&current),
                expected_openings,
                "suffix stacked: {:?}",
                current,
            );
        }
    }

    #[test]
    fn repeated_collision_naming_never_stacks_for_server_object_ids(
        name in vault_filename(),
        ids in prop::collection::vec(uuid_object_id(), NAMING_ROUNDS),
    ) {
        let mut current = collision_conflict_filename(&name, &ids[0]);
        let expected_openings = conflict_open_count(&current);
        for id in &ids[1..] {
            current = collision_conflict_filename(&current, id);
            prop_assert_eq!(
                conflict_open_count(&current),
                expected_openings,
                "suffix stacked: {:?}",
                current,
            );
        }
    }

    /// Repeated placement with arbitrary object-id shapes must replace the
    /// generated suffix instead of stacking another one.
    #[test]
    fn repeated_collision_naming_never_stacks_another_suffix(
        name in vault_filename(),
        ids in prop::collection::vec(object_id(), NAMING_ROUNDS),
    ) {
        let mut current = collision_conflict_filename(&name, &ids[0]);
        let expected_openings = conflict_open_count(&current);
        for id in &ids[1..] {
            current = collision_conflict_filename(&current, id);
            prop_assert_eq!(
                conflict_open_count(&current),
                expected_openings,
                "suffix stacked: {:?}",
                current,
            );
        }
    }

    /// Feeding each generated name back in as an existing name must keep
    /// producing fresh names — that is what stops a conflict copy from
    /// overwriting an earlier one.
    #[test]
    fn dated_naming_never_returns_a_taken_name(
        name in vault_filename(),
        date in date_token(),
        mut taken in prop::collection::hash_set(vault_filename(), 0..4),
    ) {
        for _ in 0..NAMING_ROUNDS {
            let candidate = conflict_filename(&name, &date, &taken);
            prop_assert!(
                !taken.contains(&candidate),
                "reused taken name {:?}",
                candidate,
            );
            taken.insert(candidate);
        }
    }

    /// A conflict copy is written beside its original, so the generated name
    /// must stay a single filename — never a path that reaches another folder.
    #[test]
    fn generated_names_stay_a_single_filename(
        name in vault_filename(),
        date in date_token(),
        id in object_id(),
    ) {
        for candidate in [
            conflict_filename(&name, &date, &HashSet::new()),
            collision_conflict_filename(&name, &id),
        ] {
            prop_assert!(!candidate.is_empty());
            prop_assert!(!candidate.contains('/'), "{candidate:?}");
            prop_assert!(!candidate.contains('\\'), "{candidate:?}");
            prop_assert!(candidate.contains(CONFLICT_OPEN), "{candidate:?}");
        }
    }

    #[test]
    fn naming_keeps_a_markdown_name_markdown(
        name in markdown_vault_filename(),
        date in date_token(),
        id in object_id(),
    ) {
        prop_assert!(conflict_filename(&name, &date, &HashSet::new()).ends_with(".md"));
        prop_assert!(collision_conflict_filename(&name, &id).ends_with(".md"));
    }

    /// A parked copy must land under a DIFFERENT name than the file it is
    /// parked from; otherwise the park is a no-op rename and the incoming
    /// side overwrites the local content. Every `conflict_filename` call site
    /// passes the vault's own listing as `existing`, so the original is
    /// always taken — that is what makes the distinct name guaranteed.
    #[test]
    fn dated_naming_differs_from_an_original_that_is_already_taken(
        name in vault_filename(),
        date in date_token(),
    ) {
        let taken = HashSet::from([name.clone()]);
        prop_assert_ne!(conflict_filename(&name, &date, &taken), name);
    }

    /// An empty stem used to make the first re-park a no-op. Normal generated
    /// names are deliberately fixed points; the narrower safety requirement is
    /// that stripping an empty generated stem first moves it under the fallback
    /// title, so an unguarded collision placement cannot overwrite its input.
    #[test]
    fn empty_stem_reparking_moves_to_the_safe_fallback(
        date in date_token(),
        short_id in "[0-9a-f]{8}",
    ) {
        let dated = format!(" (conflict {date}).md");
        prop_assert_eq!(
            conflict_filename(&dated, &date, &HashSet::new()),
            format!("Untitled (conflict {date}).md"),
        );

        let collided = format!(" (conflict {short_id}).md");
        prop_assert_eq!(
            collision_conflict_filename(&collided, &short_id),
            format!("Untitled (conflict {short_id}).md"),
        );
    }
}
