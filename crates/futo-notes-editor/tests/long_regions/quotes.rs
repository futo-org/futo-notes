use super::*;

#[test]
fn local_keys_in_explicit_plain_quotes_stay_at_their_small_region_work() {
    let mut small = None;
    for lines in [2_000, 20_000] {
        let source: String = (0..lines).map(|i| format!("> quoted row {i}\n")).collect();
        let needle = format!("quoted row {}", lines / 2);
        let (work, after) = keys(&source, &needle);
        assert_eq!(
            after,
            source.replacen(&format!("{needle}\n"), &format!("{needle}\n> \n"), 1)
        );
        let measured = work.map(|work| total(&work));
        if let Some(small) = small {
            for (key, (large, small)) in measured.iter().zip(small).enumerate() {
                assert!(
                    *large <= small * 3 / 2 + 1024,
                    "quote key{key}: {small} at2k, {large} at20k"
                );
            }
        } else {
            assert!(
                measured.iter().all(|work| *work < 64 * 1024),
                "quote at2k: {measured:?}"
            );
            small = Some(measured);
        }
    }
}
