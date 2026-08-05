pub(super) const TARGET_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const MAX_BATCH_ENTRIES: usize = 100;

#[derive(Debug)]
pub(super) enum TransferChunk<T> {
    Batch(Vec<T>),
    Single(T),
}

pub(super) fn pack_smallest_first<T>(
    mut items: Vec<T>,
    batch_size: impl Fn(&T) -> Option<u64>,
) -> Vec<TransferChunk<T>> {
    items.sort_by_key(|item| batch_size(item).unwrap_or(u64::MAX));
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_bytes = 0;

    fn flush<T>(current: &mut Vec<T>, current_bytes: &mut u64, chunks: &mut Vec<TransferChunk<T>>) {
        *current_bytes = 0;
        match current.len() {
            0 => {}
            1 => chunks.push(TransferChunk::Single(
                current.pop().expect("length checked"),
            )),
            _ => chunks.push(TransferChunk::Batch(std::mem::take(current))),
        }
    }

    for item in items {
        match batch_size(&item) {
            Some(size) if size < TARGET_CHUNK_BYTES => {
                if current_bytes + size > TARGET_CHUNK_BYTES || current.len() >= MAX_BATCH_ENTRIES {
                    flush(&mut current, &mut current_bytes, &mut chunks);
                }
                current_bytes += size;
                current.push(item);
            }
            _ => chunks.push(TransferChunk::Single(item)),
        }
    }
    flush(&mut current, &mut current_bytes, &mut chunks);
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Item {
        name: String,
        size: Option<u64>,
    }

    fn item(name: impl Into<String>, size: Option<u64>) -> Item {
        Item {
            name: name.into(),
            size,
        }
    }

    #[test]
    fn packs_smallest_first_under_the_byte_cap() {
        let chunks = pack_smallest_first(
            vec![
                item("large", Some(6 * 1024 * 1024)),
                item("note-1", Some(1024)),
                item("note-2", Some(2048)),
                item("note-0", Some(512)),
            ],
            |item| item.size,
        );
        let TransferChunk::Batch(items) = &chunks[0] else {
            panic!("expected one batch");
        };
        assert_eq!(
            items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["note-0", "note-1", "note-2", "large"]
        );
    }

    #[test]
    fn splits_on_byte_and_entry_caps() {
        let byte_chunks = pack_smallest_first(
            vec![
                item("a", Some(5 * 1024 * 1024)),
                item("b", Some(5 * 1024 * 1024)),
            ],
            |item| item.size,
        );
        assert!(byte_chunks
            .iter()
            .all(|chunk| matches!(chunk, TransferChunk::Single(_))));

        let entry_chunks = pack_smallest_first(
            (0..MAX_BATCH_ENTRIES + 5)
                .map(|index| item(index.to_string(), Some(10)))
                .collect(),
            |item| item.size,
        );
        assert!(
            matches!(&entry_chunks[0], TransferChunk::Batch(items) if items.len() == MAX_BATCH_ENTRIES)
        );
        assert!(matches!(&entry_chunks[1], TransferChunk::Batch(items) if items.len() == 5));
    }

    #[test]
    fn excludes_unknown_oversize_and_leftover_singletons() {
        let chunks = pack_smallest_first(
            vec![
                item("small", Some(1)),
                item("oversize", Some(TARGET_CHUNK_BYTES)),
                item("unknown", None),
            ],
            |item| item.size,
        );
        assert_eq!(chunks.len(), 3);
        assert!(chunks
            .iter()
            .all(|chunk| matches!(chunk, TransferChunk::Single(_))));
    }
}
