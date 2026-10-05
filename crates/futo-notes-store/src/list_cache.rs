//! Each note's derived `preview`, `rich_preview` and `tags`, persisted at
//! `<index_dir>.list-cache` (outside the vault) so a relaunch reads no
//! unchanged note.
//!
//! An entry is trusted only when the note's stat fingerprint matches exactly
//! and its timestamps are at least [`RACY_MARGIN_NS`] older than the pass that
//! last verified the cache: a coarse clock (ext4 ticks, FAT's 2 s mtime)
//! could otherwise hide a rewrite in the same tick. The file records the vault
//! root (the index dir is not per vault) and a checksum of the derivation
//! rules' output over probe strings, so a rule change retires old caches by
//! itself. A missing, corrupt or mismatched file is simply a cold start.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use futo_notes_model::{make_preview, make_rich_preview, note_tags};

use crate::NoteMetadata;

const MAGIC: &[u8; 4] = b"FNLC";
const FORMAT_VERSION: u32 = 3;
/// Fingerprint (5 × 8 bytes) plus four (offset, length) pairs.
const RECORD_LEN: usize = 5 * 8 + 4 * 8;

pub(crate) const RACY_MARGIN_NS: i64 = 2_000_000_000;

pub(crate) fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos().min(i64::MAX as u128) as i64)
}

/// The vault root as recorded in and compared against the file.
pub(crate) fn canonicalize_or(root: &Path) -> PathBuf {
    fs::canonicalize(root).unwrap_or_else(|_| root.to_owned())
}

/// A sibling of the search index dir, never inside the vault.
pub(crate) fn cache_file_path(index_dir: &Path) -> PathBuf {
    let mut name = index_dir.file_name().unwrap_or_default().to_owned();
    name.push(".list-cache");
    index_dir.with_file_name(name)
}

/// Unix: length, mtime, ctime, inode, device. ctime catches sync's post-write
/// mtime restore and the inode an atomic-rename save. Windows has no stable
/// ctime or file id in std, so it gets length, last-write and creation time.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct Fingerprint {
    len: u64,
    mtime_ns: i64,
    ctime_ns: i64,
    id_a: u64,
    id_b: u64,
}

impl Fingerprint {
    #[cfg(unix)]
    pub(crate) fn of(metadata: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        let ns = |secs: i64, nanos: i64| secs.saturating_mul(1_000_000_000).saturating_add(nanos);
        Self {
            len: metadata.len(),
            mtime_ns: ns(metadata.mtime(), metadata.mtime_nsec()),
            ctime_ns: ns(metadata.ctime(), metadata.ctime_nsec()),
            id_a: metadata.ino(),
            id_b: metadata.dev(),
        }
    }

    #[cfg(not(unix))]
    pub(crate) fn of(metadata: &fs::Metadata) -> Self {
        let ns = |time: std::io::Result<SystemTime>| {
            time.ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_nanos().min(i64::MAX as u128) as i64)
        };
        let mtime_ns = ns(metadata.modified());
        Self {
            len: metadata.len(),
            mtime_ns,
            ctime_ns: mtime_ns,
            id_a: ns(metadata.created()) as u64,
            id_b: 0,
        }
    }

    /// Too close to `threshold_ns` to trust an equal fingerprint.
    pub(crate) fn is_racy(&self, threshold_ns: i64) -> bool {
        self.mtime_ns >= threshold_ns || self.ctime_ns >= threshold_ns
    }
}

/// One note as the next generation stores it.
pub(crate) struct Entry {
    id: String,
    fingerprint: Fingerprint,
    preview: String,
    rich_preview: String,
    tags: Vec<String>,
}

impl Entry {
    pub(crate) fn of(note: &NoteMetadata, fingerprint: Fingerprint) -> Self {
        Self {
            id: note.id.clone(),
            fingerprint,
            preview: note.preview.clone(),
            rich_preview: note.rich_preview.clone(),
            tags: note.tags.clone(),
        }
    }
}

/// One note as a loaded generation holds it, borrowed from its buffer.
pub(crate) struct Cached<'a> {
    pub(crate) fingerprint: Fingerprint,
    preview: &'a str,
    rich_preview: &'a str,
    tags: Vec<&'a str>,
}

impl Cached<'_> {
    pub(crate) fn to_owned_fields(&self) -> (String, String, Vec<String>) {
        let tags = self.tags.iter().map(|tag| (*tag).to_owned()).collect();
        (self.preview.to_owned(), self.rich_preview.to_owned(), tags)
    }

    pub(crate) fn same(
        &self,
        fingerprint: Fingerprint,
        preview: &str,
        rich_preview: &str,
        tags: &[String],
    ) -> bool {
        self.fingerprint == fingerprint
            && self.preview == preview
            && self.rich_preview == rich_preview
            && self.tags.len() == tags.len()
            && self
                .tags
                .iter()
                .zip(tags)
                .all(|(left, right)| *left == right)
    }
}

/// A checksum of every derivation rule's output over fixed probes, so a
/// behavior change in any rule invalidates every persisted cache.
fn rules_fingerprint() -> u32 {
    static RULES: OnceLock<u32> = OnceLock::new();
    *RULES.get_or_init(|| {
        const PROBES: &[&str] = &[
            "",
            "line1\nline2\r\nline3",
            "# Heading\n\nSome *text* with `code` and a [link](http://example.com).",
            "![alt](image.png) text ![broken](no close",
            "<br />\n<br>\n<BR >\nkeep <kbd>K</kbd>",
            "```\n#not_a_tag\n```\n~~~\n#nor_this\n~~~\n`#inline` #real_tag",
            "#a #tag_2 #Tag-3 #this_tag_is_exactly_fifty_chars_long_ok1234567 #toolong_toolong_toolong_toolong_toolong_toolong_x",
            "- [ ] todo\n- [x] done\n* bullet\n| a | b |\n| - | - |\n> quote",
            "日本語 #タグ 🎉 café résumé Straße",
        ];
        let mut hasher = crc32fast::Hasher::new();
        let long = "x".repeat(300);
        for probe in PROBES.iter().copied().chain([long.as_str()]) {
            hasher.update(make_preview(probe).as_bytes());
            hasher.update(b"\0");
            hasher.update(make_rich_preview(probe).as_bytes());
            for tag in note_tags(probe) {
                hasher.update(b"\0");
                hasher.update(tag.as_bytes());
            }
            hasher.update(b"\xff");
        }
        hasher.finalize()
    })
}

struct Record {
    fingerprint: Fingerprint,
    /// (offset, length) of the id, preview, rich preview and tags.
    fields: [(u32, u32); 4],
}

/// One cache generation: records sorted by id over one byte buffer, the file
/// itself once loaded. A lookup is a binary search, and a field is UTF-8
/// checked only when read, so a damaged record is a miss, never a panic.
#[derive(Default)]
pub(crate) struct Generation {
    bytes: Vec<u8>,
    records: Vec<Record>,
    root: PathBuf,
    built_at_ns: i64,
}

impl Generation {
    fn encode(root: &Path, built_at_ns: i64, mut entries: Vec<Entry>) -> Vec<u8> {
        entries.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        let root = root.to_string_lossy();
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&rules_fingerprint().to_le_bytes());
        out.extend_from_slice(&built_at_ns.to_le_bytes());
        out.extend_from_slice(&(root.len() as u32).to_le_bytes());
        out.extend_from_slice(root.as_bytes());
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        let blob_start = out.len() + entries.len() * RECORD_LEN;
        let mut blob = Vec::new();
        let mut field = |bytes: &[u8]| {
            let at = (blob_start + blob.len()) as u32;
            blob.extend_from_slice(bytes);
            (at, bytes.len() as u32)
        };
        for entry in &entries {
            let mut tags = Vec::new();
            for tag in &entry.tags {
                tags.extend_from_slice(&(tag.len() as u32).to_le_bytes());
                tags.extend_from_slice(tag.as_bytes());
            }
            let print = entry.fingerprint;
            for value in [
                print.len,
                print.mtime_ns as u64,
                print.ctime_ns as u64,
                print.id_a,
                print.id_b,
            ] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            for (at, len) in [
                field(entry.id.as_bytes()),
                field(entry.preview.as_bytes()),
                field(entry.rich_preview.as_bytes()),
                field(&tags),
            ] {
                out.extend_from_slice(&at.to_le_bytes());
                out.extend_from_slice(&len.to_le_bytes());
            }
        }
        out.extend_from_slice(&blob);
        let checksum = crc32fast::hash(&out);
        out.extend_from_slice(&checksum.to_le_bytes());
        out
    }

    fn decode(mut bytes: Vec<u8>) -> Option<Self> {
        let body = bytes.len().checked_sub(4)?;
        if crc32fast::hash(&bytes[..body]).to_le_bytes() != bytes[body..] {
            return None;
        }
        bytes.truncate(body);
        let mut reader = Reader(&bytes);
        let (built_at_ns, root, count) = reader.header()?;
        let mut records = Vec::with_capacity(count.min(bytes.len() / RECORD_LEN));
        for _ in 0..count {
            records.push(reader.record()?);
        }
        Some(Self {
            bytes,
            records,
            root,
            built_at_ns,
        })
    }

    fn field(&self, (at, len): (u32, u32)) -> Option<&[u8]> {
        let at = at as usize;
        self.bytes.get(at..at.checked_add(len as usize)?)
    }

    fn text(&self, field: (u32, u32)) -> Option<&str> {
        simdutf8::basic::from_utf8(self.field(field)?).ok()
    }

    pub(crate) fn len(&self) -> usize {
        self.records.len()
    }

    pub(crate) fn get(&self, id: &str) -> Option<Cached<'_>> {
        let index = self
            .records
            .binary_search_by(|record| {
                self.field(record.fields[0])
                    .unwrap_or_default()
                    .cmp(id.as_bytes())
            })
            .ok()?;
        let record = &self.records[index];
        let mut tags = Vec::new();
        let mut reader = Reader(self.field(record.fields[3])?);
        while !reader.0.is_empty() {
            let len = reader.u32()? as usize;
            tags.push(simdutf8::basic::from_utf8(reader.take(len)?).ok()?);
        }
        Some(Cached {
            fingerprint: record.fingerprint,
            preview: self.text(record.fields[1])?,
            rich_preview: self.text(record.fields[2])?,
            tags,
        })
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(len)?;
        self.0 = rest;
        Some(head)
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    /// `(built_at_ns, root, record count)`, or `None` for another format or
    /// rule set.
    fn header(&mut self) -> Option<(i64, PathBuf, usize)> {
        let ours = self.take(4)? == MAGIC
            && self.u32()? == FORMAT_VERSION
            && self.u32()? == rules_fingerprint();
        if !ours {
            return None;
        }
        let built_at_ns = self.u64()? as i64;
        let root_len = self.u32()? as usize;
        let root = PathBuf::from(std::str::from_utf8(self.take(root_len)?).ok()?);
        Some((built_at_ns, root, self.u32()? as usize))
    }

    fn record(&mut self) -> Option<Record> {
        let fingerprint = Fingerprint {
            len: self.u64()?,
            mtime_ns: self.u64()? as i64,
            ctime_ns: self.u64()? as i64,
            id_a: self.u64()?,
            id_b: self.u64()?,
        };
        let mut fields = [(0, 0); 4];
        for field in &mut fields {
            *field = (self.u32()?, self.u32()?);
        }
        Some(Record {
            fingerprint,
            fields,
        })
    }
}

/// Rebuildable, so no fsync: a torn write fails the checksum. One fixed temp
/// name means a crash mid-write leaves at most one stray file, replaced by the
/// next write; writes within a process are serialized by [`ListCache`].
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

#[derive(Default)]
struct State {
    generation: Arc<Generation>,
    /// When the current generation's entries were last verified.
    built_at_ns: i64,
    path: Option<PathBuf>,
}

/// The store's cache. In memory only until `bootstrap_with_search` gives it an
/// index dir to persist next to.
#[derive(Default)]
pub(crate) struct ListCache {
    state: Arc<Mutex<State>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl ListCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn ensure_disk_loaded(&self, root: &Path, index_dir: &Path) {
        let path = cache_file_path(index_dir);
        let mut state = self.state.lock().unwrap();
        if state.path.as_ref() == Some(&path) {
            return;
        }
        let generation = fs::read(&path)
            .ok()
            .and_then(Generation::decode)
            .filter(|generation| generation.root == root)
            .unwrap_or_default();
        state.built_at_ns = generation.built_at_ns;
        state.generation = Arc::new(generation);
        state.path = Some(path);
    }

    pub(crate) fn current(&self) -> (Arc<Generation>, i64) {
        let state = self.state.lock().unwrap();
        (Arc::clone(&state.generation), state.built_at_ns)
    }

    pub(crate) fn is_disk_backed(&self) -> bool {
        self.state.lock().unwrap().path.is_some()
    }

    /// Installs a pass's result. With `None` every entry was just verified and
    /// only `built_at` moves. Otherwise the next generation is encoded,
    /// persisted and installed on a background thread; a pass that runs
    /// before it lands only sees more misses.
    pub(crate) fn commit(&self, root: &Path, built_at_ns: i64, entries: Option<Vec<Entry>>) {
        let Some(entries) = entries else {
            self.state.lock().unwrap().built_at_ns = built_at_ns;
            return;
        };
        let path = self.state.lock().unwrap().path.clone();
        let state = Arc::clone(&self.state);
        let root = root.to_owned();
        let mut writer = self.writer.lock().unwrap();
        if let Some(previous) = writer.take() {
            let _ = previous.join();
        }
        *writer = Some(std::thread::spawn(move || {
            let bytes = Generation::encode(&root, built_at_ns, entries);
            if let Some(path) = &path {
                if let Err(error) = write_atomic(path, &bytes) {
                    futo_notes_core::log_to_stderr!("list cache write {}: {error}", path.display());
                }
            }
            if let Some(generation) = Generation::decode(bytes) {
                let mut state = state.lock().unwrap();
                state.generation = Arc::new(generation);
                state.built_at_ns = built_at_ns;
            }
        }));
    }

    #[cfg(test)]
    pub(crate) fn wait_for_pending_write(&self) {
        if let Some(writer) = self.writer.lock().unwrap().take() {
            let _ = writer.join();
        }
    }

    /// Pretends the current generation was verified at `built_at_ns`, so a
    /// test can exercise real hits without waiting out the racy margin.
    #[cfg(test)]
    pub(crate) fn set_built_at_for_test(&self, built_at_ns: i64) {
        self.state.lock().unwrap().built_at_ns = built_at_ns;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, tags: &[&str]) -> Entry {
        Entry {
            id: id.to_owned(),
            fingerprint: Fingerprint {
                len: 3,
                mtime_ns: 4,
                ctime_ns: 5,
                id_a: 6,
                id_b: 7,
            },
            preview: format!("{id} preview"),
            rich_preview: format!("{id}\nrich 🎉"),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        }
    }

    #[test]
    fn a_generation_round_trips_and_any_damage_is_a_cold_start() {
        let root = Path::new("/vault");
        let bytes = Generation::encode(
            root,
            42,
            vec![entry("b/日本", &[]), entry("a", &["#x", "#yy"])],
        );
        let generation = Generation::decode(bytes.clone()).unwrap();
        assert_eq!(
            (generation.root.as_path(), generation.built_at_ns),
            (root, 42)
        );
        let cached = generation.get("a").unwrap();
        assert_eq!(
            cached.to_owned_fields(),
            (
                "a preview".into(),
                "a\nrich 🎉".into(),
                vec!["#x".into(), "#yy".into()]
            )
        );
        assert!(generation.get("b/日本").unwrap().tags.is_empty());
        assert!(generation.get("c").is_none());

        for cut in 0..bytes.len() {
            assert!(
                Generation::decode(bytes[..cut].to_vec()).is_none(),
                "cut {cut}"
            );
        }
        for at in 0..bytes.len() {
            let mut flipped = bytes.clone();
            flipped[at] ^= 0x40;
            assert!(Generation::decode(flipped).is_none(), "flip {at}");
        }
        // A different rule set, with a valid checksum, is still rejected.
        let mut other_rules = bytes[..bytes.len() - 4].to_vec();
        other_rules[8] ^= 1;
        let checksum = crc32fast::hash(&other_rules);
        other_rules.extend_from_slice(&checksum.to_le_bytes());
        assert!(Generation::decode(other_rules).is_none());
    }

    #[test]
    fn a_cache_written_for_another_vault_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let index_dir = dir.path().join("search");
        let bytes = Generation::encode(&dir.path().join("other"), 1, vec![entry("a", &[])]);
        fs::write(cache_file_path(&index_dir), bytes).unwrap();
        let cache = ListCache::new();
        cache.ensure_disk_loaded(&dir.path().join("vault"), &index_dir);
        assert_eq!(cache.current().0.len(), 0);
        assert_eq!(
            cache_file_path(&index_dir),
            dir.path().join("search.list-cache")
        );
    }
}
