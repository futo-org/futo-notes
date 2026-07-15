use super::E2eeError;

const NOTE_FRAME_V2: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpackedNote {
    pub path: String,
    pub content: String,
}

pub fn pack_note_v2(path: &str, content: &str) -> Vec<u8> {
    let path_bytes = path.as_bytes();
    let content_bytes = content.as_bytes();
    let mut frame = Vec::with_capacity(1 + 4 + path_bytes.len() + content_bytes.len());
    frame.push(NOTE_FRAME_V2);
    frame.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(path_bytes);
    frame.extend_from_slice(content_bytes);
    frame
}

pub fn unpack_note(data: &[u8]) -> Result<UnpackedNote, E2eeError> {
    if data.is_empty() {
        return Err(E2eeError::EmptyBlob);
    }
    let first = data[0];
    if first == NOTE_FRAME_V2 {
        if data.len() < 5 {
            return Err(E2eeError::TruncatedV2);
        }
        let path_len = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;
        let path_end = 5usize
            .checked_add(path_len)
            .ok_or(E2eeError::V2PathOutOfBounds)?;
        if path_end > data.len() {
            return Err(E2eeError::V2PathOutOfBounds);
        }
        let path = std::str::from_utf8(&data[5..path_end])?.to_owned();
        let content = std::str::from_utf8(&data[path_end..])?.to_owned();
        return Ok(UnpackedNote { path, content });
    }
    // A supported V1 path is under 16 MiB, so its big-endian length starts with zero.
    if first != 0x00 {
        return Err(E2eeError::UnknownFrame(first));
    }
    if data.len() < 4 {
        return Err(E2eeError::V1PathOutOfBounds);
    }
    let path_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let path_end = 4usize
        .checked_add(path_len)
        .ok_or(E2eeError::V1PathOutOfBounds)?;
    if path_end > data.len() {
        return Err(E2eeError::V1PathOutOfBounds);
    }
    let path = std::str::from_utf8(&data[4..path_end])?.to_owned();
    let content = std::str::from_utf8(&data[path_end..])?.to_owned();
    Ok(UnpackedNote { path, content })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_round_trip_basic() {
        let blob = pack_note_v2("hello.md", "world");
        let note = unpack_note(&blob).unwrap();
        assert_eq!(note.path, "hello.md");
        assert_eq!(note.content, "world");
    }

    #[test]
    fn v2_round_trip_nested_path() {
        let blob = pack_note_v2("Specs/folder/note.md", "# Heading\n\nbody");
        let note = unpack_note(&blob).unwrap();
        assert_eq!(note.path, "Specs/folder/note.md");
        assert_eq!(note.content, "# Heading\n\nbody");
    }

    #[test]
    fn v2_round_trip_unicode_in_path_and_content() {
        let blob = pack_note_v2("カフェ.md", "café\n☕️");
        let note = unpack_note(&blob).unwrap();
        assert_eq!(note.path, "カフェ.md");
        assert_eq!(note.content, "café\n☕️");
    }

    #[test]
    fn v2_round_trip_empty_content() {
        let blob = pack_note_v2("empty.md", "");
        let note = unpack_note(&blob).unwrap();
        assert_eq!(note.path, "empty.md");
        assert_eq!(note.content, "");
    }

    #[test]
    fn v1_decoded_by_unpack() {
        let mut blob = vec![0, 0, 0, 9];
        blob.extend_from_slice(b"legacy.mdlegacy content");
        let note = unpack_note(&blob).unwrap();
        assert_eq!(note.path, "legacy.md");
        assert_eq!(note.content, "legacy content");
    }

    #[test]
    fn unpack_rejects_empty() {
        assert!(matches!(unpack_note(&[]), Err(E2eeError::EmptyBlob)));
    }

    #[test]
    fn unpack_rejects_truncated_v2() {
        assert!(matches!(
            unpack_note(&[NOTE_FRAME_V2, 0, 0]),
            Err(E2eeError::TruncatedV2)
        ));
    }

    #[test]
    fn unpack_rejects_v2_out_of_bounds() {
        let bad = [NOTE_FRAME_V2, 0, 0, 0, 100, b'h', b'i'];
        assert!(matches!(
            unpack_note(&bad),
            Err(E2eeError::V2PathOutOfBounds)
        ));
    }

    #[test]
    fn unpack_rejects_unknown_frame_version() {
        let bad = [0x03, 0, 0, 0, 0];
        assert!(matches!(
            unpack_note(&bad),
            Err(E2eeError::UnknownFrame(0x03))
        ));
    }

    #[test]
    fn v2_byte_layout_matches_ts() {
        let blob = pack_note_v2("ab", "cd");
        assert_eq!(blob, vec![0x02, 0, 0, 0, 2, b'a', b'b', b'c', b'd']);
    }
}
