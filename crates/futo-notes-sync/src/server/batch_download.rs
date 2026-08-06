#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchBlobStatus {
    Ok,
    Missing,
    Omitted,
}

#[derive(Debug, Clone)]
pub(crate) struct BatchBlobEntry {
    pub key: String,
    pub status: BatchBlobStatus,
    pub bytes: Vec<u8>,
}

pub(super) fn parse_batch_frames(body: &[u8]) -> Result<Vec<BatchBlobEntry>, String> {
    let mut entries = Vec::new();
    let mut offset = 0;
    while offset < body.len() {
        let Some(key_length_end) = offset.checked_add(2).filter(|end| *end <= body.len()) else {
            return Err(format!("truncated frame header at offset {offset}"));
        };
        let key_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
        offset = key_length_end;
        let Some(frame_header_end) = offset
            .checked_add(key_len)
            .and_then(|end| end.checked_add(5))
            .filter(|end| *end <= body.len())
        else {
            return Err(format!("truncated frame at offset {offset}"));
        };
        let key = std::str::from_utf8(&body[offset..offset + key_len])
            .map_err(|_| format!("non-UTF-8 key at offset {offset}"))?
            .to_owned();
        offset += key_len;
        let status = match body[offset] {
            0 => BatchBlobStatus::Ok,
            1 => BatchBlobStatus::Missing,
            2 => BatchBlobStatus::Omitted,
            other => {
                return Err(format!("unknown frame status {other} for key {key}"));
            }
        };
        offset += 1;
        let blob_len = u32::from_be_bytes([
            body[offset],
            body[offset + 1],
            body[offset + 2],
            body[offset + 3],
        ]) as usize;
        offset += 4;
        let Some(blob_end) = offset
            .checked_add(blob_len)
            .filter(|end| *end <= body.len())
        else {
            return Err(format!("blob for key {key} runs past end of body"));
        };
        debug_assert_eq!(frame_header_end, offset);
        let bytes = body[offset..blob_end].to_vec();
        offset = blob_end;
        match status {
            BatchBlobStatus::Ok if bytes.is_empty() => {
                return Err(format!("ok frame for key {key} has an empty payload"));
            }
            BatchBlobStatus::Missing | BatchBlobStatus::Omitted if !bytes.is_empty() => {
                return Err(format!(
                    "{status:?} frame for key {key} has an unexpected payload"
                ));
            }
            _ => {}
        }
        entries.push(BatchBlobEntry { key, status, bytes });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(key: &str, status: u8, blob: &[u8]) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(&(key.len() as u16).to_be_bytes());
        frame.extend_from_slice(key.as_bytes());
        frame.push(status);
        frame.extend_from_slice(&(blob.len() as u32).to_be_bytes());
        frame.extend_from_slice(blob);
        frame
    }

    #[test]
    fn batch_blob_frames_decode_all_statuses_and_reject_malformed_bodies() {
        let mut body = frame("key-1", 0, b"abc");
        body.extend(frame("key-2", 1, b""));
        body.extend(frame("key-3", 2, b""));
        let entries = parse_batch_frames(&body).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].key, "key-1");
        assert_eq!(entries[0].status, BatchBlobStatus::Ok);
        assert_eq!(entries[0].bytes, b"abc");
        assert_eq!(entries[1].status, BatchBlobStatus::Missing);
        assert_eq!(entries[2].status, BatchBlobStatus::Omitted);

        let mut truncated_blob = frame("key", 0, b"abc");
        truncated_blob.pop();
        assert!(parse_batch_frames(&truncated_blob).is_err());
        assert!(parse_batch_frames(&[0]).is_err());
        assert!(parse_batch_frames(&frame("key", 9, b"")).is_err());
        let invalid_utf8 = [0, 1, 0xff, 1, 0, 0, 0, 0];
        assert!(parse_batch_frames(&invalid_utf8).is_err());
    }

    #[test]
    fn batch_blob_frames_reject_illegal_status_payload_combinations() {
        assert!(parse_batch_frames(&frame("empty-ok", 0, b"")).is_err());
        assert!(parse_batch_frames(&frame("missing-with-bytes", 1, b"unexpected")).is_err());
        assert!(parse_batch_frames(&frame("omitted-with-bytes", 2, b"unexpected")).is_err());
    }
}
