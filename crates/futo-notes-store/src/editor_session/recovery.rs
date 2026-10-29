use std::fs::File;
use std::io::Write;
use std::path::Path;

use futo_notes_core::{files::vault_fs, hash::hash_sha256};
use futo_notes_editor::{EditorSession, Revision, SourceEdit};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    vault: String,
    id: String,
    base: String,
    base_revision: Revision,
}

pub(super) struct RecoveryLog {
    path: String,
    header: Header,
    file: Option<File>,
    failed: bool,
    #[cfg(test)]
    pub(super) append_hook: Option<Box<dyn Fn(bool)>>,
    #[cfg(test)]
    pub(super) fail_retirement: bool,
}

impl RecoveryLog {
    pub(super) fn open(root: &Path, id: &str, disk: &str) -> Result<(Self, EditorSession), String> {
        let path = format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id));
        let vault = root
            .canonicalize()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let (header, engine) = match vault_fs::read_optional(root, &path)? {
            None => (
                Header {
                    version: 1,
                    vault,
                    id: id.to_owned(),
                    base: disk.to_owned(),
                    base_revision: Revision(0),
                },
                EditorSession::open(disk),
            ),
            Some(bytes) => {
                if !bytes.ends_with(b"\n") {
                    return Err("incomplete editor recovery record; log retained".to_owned());
                }
                let mut lines = bytes.split(|byte| *byte == b'\n');
                let header: Header = serde_json::from_slice(lines.next().unwrap_or_default())
                    .map_err(|error| error.to_string())?;
                if header.version != 1 || header.vault != vault || header.id != id {
                    return Err(
                        "editor recovery identity or version mismatch; log retained".to_owned()
                    );
                }
                let mut engine = EditorSession::restore(&header.base, header.base_revision);
                for line in lines.filter(|line| !line.is_empty()) {
                    let edit: SourceEdit =
                        serde_json::from_slice(line).map_err(|error| error.to_string())?;
                    engine.replay(&edit).map_err(|error| error.to_string())?;
                }
                (header, engine)
            }
        };
        Ok((
            Self {
                path,
                header,
                file: None,
                failed: false,
                #[cfg(test)]
                append_hook: None,
                #[cfg(test)]
                fail_retirement: false,
            },
            engine,
        ))
    }

    pub(super) fn base(&self) -> &str {
        &self.header.base
    }

    pub(super) fn append(&mut self, root: &Path, edit: &SourceEdit) -> Result<(), String> {
        if self.failed {
            return Err(
                "editor recovery append failed; reopen or retry recovery before editing".to_owned(),
            );
        }
        #[cfg(test)]
        if let Some(hook) = &self.append_hook {
            hook(false);
        }
        let result = self.append_record(root, edit);
        if result.is_err() {
            self.failed = true;
        }
        #[cfg(test)]
        if result.is_ok() {
            if let Some(hook) = &self.append_hook {
                hook(true);
            }
        }
        result
    }

    fn append_record(&mut self, root: &Path, edit: &SourceEdit) -> Result<(), String> {
        if self.file.is_none() {
            let mut header = serde_json::to_vec(&self.header).map_err(|error| error.to_string())?;
            header.push(b'\n');
            vault_fs::create_new(root, &self.path, &header)?;
            self.file = Some(vault_fs::open_append(root, &self.path)?);
        }
        let mut record = serde_json::to_vec(edit).map_err(|error| error.to_string())?;
        record.push(b'\n');
        self.file
            .as_mut()
            .unwrap()
            .write_all(&record)
            .map_err(|error| error.to_string())
    }

    pub(super) fn retire(
        &mut self,
        root: &Path,
        id: &str,
        source: &str,
        revision: Revision,
    ) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_retirement {
            return Err("injected recovery retirement failure".to_owned());
        }
        // Close the append handle before unlink, including on Windows. A failed
        // retirement leaves the old base usable for repeat recovery.
        self.file = None;
        vault_fs::remove(root, &self.path)?;
        self.path = format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id));
        self.header.id = id.to_owned();
        self.header.base = source.to_owned();
        self.header.base_revision = revision;
        self.failed = false;
        Ok(())
    }
}
