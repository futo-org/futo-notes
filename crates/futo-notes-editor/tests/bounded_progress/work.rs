use futo_notes_editor::*;

#[test]
fn the_same_pending_shape_has_bounded_steps_at_one_and_twenty_thousand_units() {
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    for count in [1_000, 20_000] {
        let source = format!(
            "```Rust\nab\n```\n\n{}middle\n\n{paragraph}",
            paragraph.repeat(count - 2)
        );
        let mut bounded = EditorSession::open(&source)
            .into_bounded(Revision(0), SessionToken(24), DisplayOffset(0))
            .unwrap();
        let preparation = bounded.preparation_work();
        let initial = bounded
            .remove_fence_closer(bounded.cursor(), &mut |_| Ok(()))
            .unwrap();
        let at = bounded.display_text().rfind("plain").unwrap() + 2;
        let selected = bounded
            .select_bounded(
                bounded.cursor(),
                DisplayRange {
                    start: DisplayOffset(at),
                    end: DisplayOffset(at),
                },
                Affinity::Backward,
            )
            .unwrap();
        let mut max_metadata = initial.work.metadata_items;
        let mut max_copied = initial.work.copied_bytes;
        let mut max_output = initial.work.returned_text_bytes;
        let mut steps = 0;
        let mut observe = |work: &BoundedWork| {
            assert_eq!(work.parsed_source_bytes, 0);
            assert!(work.inspected_source_bytes <= 512);
            assert!(work.copied_bytes <= 16384);
            assert!(work.returned_records <= 512);
            assert!(work.returned_text_bytes <= 512);
            assert!(
                work.metadata_items <= 128,
                "actual indexed selection visits must be charged: {work:?}"
            );
            max_metadata = max_metadata.max(work.metadata_items);
            max_copied = max_copied.max(work.copied_bytes);
            max_output = max_output.max(work.returned_text_bytes);
        };
        match selected {
            BoundedProgress::Change(ref frame) => observe(&frame.work),
            BoundedProgress::Status(ref frame) => observe(&frame.work),
        }
        while let Some(continuation) = bounded.continuation() {
            let frame = bounded.continue_projection(continuation).unwrap();
            match frame {
                BoundedProgress::Change(ref frame) => observe(&frame.work),
                BoundedProgress::Status(ref frame) => observe(&frame.work),
            }
            steps += 1;
            assert!(steps <= count + 2);
        }
        assert!(steps >= count - 1);
        println!("units={count} preparation_metadata={} steps={steps} max_metadata={max_metadata} max_copied={max_copied} max_output={max_output}", preparation.metadata_items);
        assert_eq!(
            bounded.display_text(),
            format!(
                "ab\n\n\n{}middle\n\n{}",
                paragraph.repeat(count - 2),
                paragraph.strip_suffix('\n').unwrap()
            )
        );
    }
}
