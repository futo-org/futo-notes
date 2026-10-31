//! A bounded incomplete WWW prefix hint, never URI grammar or data normalization.
pub(super) fn matches(prefix: &[u8], shown: usize, work: &mut usize) -> bool {
    *work += 1;
    if shown == 0 {
        return false;
    }
    let expected = if shown <= 3 {
        &b"www"[..shown]
    } else {
        &b"www."[..]
    };
    let Some(actual) = prefix.get(..expected.len()) else {
        return false;
    };
    actual.iter().zip(expected).all(|(a, b)| {
        *work += 1;
        a.eq_ignore_ascii_case(b)
    })
}
