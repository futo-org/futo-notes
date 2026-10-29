//! Inputs representing corrupt files or valid streams from an older run.

// Test files are inputs to the public storage seam. Re-sealing a deliberately
// changed fixture models a valid older stream, rather than accidental bit rot.
pub(super) fn alter_frame(
    bytes: &mut Vec<u8>,
    record: usize,
    change: impl FnOnce(&mut serde_json::Value),
) {
    let mut lines: Vec<Vec<u8>> = bytes
        .split_inclusive(|byte| *byte == b'\n')
        .map(|line| line.to_vec())
        .collect();
    let mut frame: serde_json::Value = serde_json::from_slice(&lines[record]).unwrap();
    let mut payload: serde_json::Value =
        serde_json::from_str(frame["payload"].as_str().unwrap()).unwrap();
    change(&mut payload);
    let payload = serde_json::to_string(&payload).unwrap();
    frame["sha256"] = futo_notes_core::hash::hash_sha256(&payload).into();
    frame["payload"] = payload.into();
    lines[record] = serde_json::to_vec(&frame).unwrap();
    lines[record].push(b'\n');
    *bytes = lines.concat();
}

pub(super) fn invalidate_stream(case: &str, bytes: &mut Vec<u8>) {
    match case {
        "duplicate" | "blank-interior" => {
            let lines: Vec<&[u8]> = bytes.split_inclusive(|byte| *byte == b'\n').collect();
            *bytes = [
                lines[0],
                lines[1],
                if case == "duplicate" { lines[1] } else { b"\n" },
                lines[2],
            ]
            .concat();
        }
        "invalid-edit" => alter_frame(bytes, 2, |payload| {
            payload["Edit"]["removed"] = "missing".into()
        }),
        "wrong-note" => alter_frame(bytes, 0, |payload| payload["id"] = "other".into()),
        "wrong-vault" => alter_frame(bytes, 0, |payload| {
            payload["vault"] = "/some/other/vault".into()
        }),
        "version" => alter_frame(bytes, 0, |payload| payload["version"] = 999.into()),
        "header-corruption" => bytes[0] = b'!',
        _ => unreachable!(),
    }
}
