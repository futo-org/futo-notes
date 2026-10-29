//! A discoverable prepared intent and exclusive durable commit decision keep
//! the original stream until its retargeted replacement is durably installed.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Intent {
    header: Header,
    records: Vec<u8>,
    exists: bool,
    destination: String,
    expected_disk: Vec<String>,
    replaced: bool,
}
#[derive(Serialize, Deserialize)]
struct Decision {
    intent: Intent,
    header: Header,
    stream: Vec<u8>,
}
fn stem(id: &str) -> String {
    format!(".futo-editor-recovery/{}.retarget", hash_sha256(id))
}
fn stream(id: &str) -> String {
    format!(".futo-editor-recovery/{}.jsonl", hash_sha256(id))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    format::decode(bytes, 0).map_err(|error| format!("invalid editor identity intent: {error:?}"))
}

impl RecoveryLog {
    pub(in crate::editor_session) fn prepare_identity(
        &mut self,
        root: &Path,
        destination: &str,
        expected_disk: Vec<String>,
    ) -> Result<(), String> {
        Self::recover_identities(root, &self.header.id, &mut *self.storage)?;
        let records = if self.exists {
            let bytes = self
                .storage
                .read(root, &self.path)?
                .ok_or("editor stream disappeared")?;
            let first = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or("incomplete recovery header")?
                + 1;
            bytes
                .get(first..self.accepted_bytes as usize)
                .ok_or("incomplete accepted recovery prefix")?
                .to_vec()
        } else {
            Vec::new()
        };
        let intent = Intent {
            header: self.header.clone(),
            records,
            exists: self.exists,
            destination: destination.to_owned(),
            expected_disk,
            replaced: self.replaced(root)?,
        };
        let path = stem(&self.header.id);
        self.storage
            .create(root, &path, &format::encode(&intent)?)?;
        self.storage.flush(root, &path)
    }

    pub(in crate::editor_session) fn identity_destination_ready(
        &mut self,
        root: &Path,
        original: &str,
    ) -> Result<bool, String> {
        if let Some(bytes) = self
            .storage
            .read(root, &format!("{}.committed", stem(original)))?
        {
            let decision: Decision = decode(&bytes)?;
            let found = self.storage.read(root, &stream(&decision.header.id))?;
            Ok(found.is_none_or(|found| found == decision.stream))
        } else {
            let bytes = self
                .storage
                .read(root, &stem(original))?
                .ok_or("identity intent disappeared")?;
            let intent: Intent = decode(&bytes)?;
            Ok(self
                .storage
                .read(root, &stream(&intent.destination))?
                .is_none())
        }
    }

    pub(in crate::editor_session) fn complete_identity(
        &mut self,
        root: &Path,
        original: &str,
    ) -> Result<(), String> {
        if self.header.id != original {
            return cleanup(root, &stem(original), &mut *self.storage);
        }
        let decision = complete(root, &stem(original), &mut *self.storage)?;
        self.path = stream(&decision.header.id);
        self.header = decision.header;
        self.exists = decision.intent.exists;
        self.accepted_bytes = decision.stream.len() as u64;
        self.durable = self.accepted;
        self.flush_deadline = None;
        self.failed = false;
        cleanup(root, &stem(original), &mut *self.storage)
    }

    pub(in crate::editor_session) fn recover_identities(
        root: &Path,
        id: &str,
        storage: &mut dyn RecoveryStorage,
    ) -> Result<(), String> {
        let mut paths = storage
            .list(root)?
            .into_iter()
            .filter_map(|path| {
                if path.ends_with(".retarget") {
                    Some(path)
                } else {
                    path.strip_suffix(".retarget.committed")
                        .map(|prefix| format!("{prefix}.retarget"))
                }
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        for path in paths {
            if let Some(bytes) = storage.read(root, &format!("{path}.committed"))? {
                let decision: Decision = decode(&bytes)?;
                if decision.header.id == id || decision.intent.header.id == id {
                    validate(root, &decision.intent)?;
                    if decision.header.id == id
                        && storage
                            .read(root, &stream(id))?
                            .is_some_and(|found| found != decision.stream)
                    {
                        continue;
                    }
                    complete(root, &path, storage)?;
                    cleanup(root, &path, storage)?;
                }
            } else if let Some(bytes) = storage.read(root, &path)? {
                let intent: Intent = decode(&bytes)?;
                if intent.header.id != id && intent.destination != id {
                    continue;
                }
                validate(root, &intent)?;
                if intent.destination == id && storage.read(root, &stream(id))?.is_some() {
                    continue;
                }
                let old = crate::note_filename(&intent.header.id);
                let destination = crate::note_filename(&intent.destination);
                let exact_source = futo_notes_core::files::collision_key(&intent.header.id)
                    != futo_notes_core::files::collision_key(&intent.destination)
                    || crate::vault::note_paths(root)
                        .iter()
                        .any(|(found, _)| found == &intent.header.id);
                if let Some(old_disk) = futo_notes_core::files::vault_fs::read_optional(root, &old)?
                    .filter(|_| exact_source)
                {
                    // A prepared operation never moved, or rolled back. Its
                    // original live stream may have accepted further edits.
                    if intent
                        .expected_disk
                        .first()
                        .is_some_and(|expected| expected.as_bytes() == old_disk)
                    {
                        storage.remove(root, &path)?;
                        continue;
                    }
                    return Err("prepared identity source changed; intent retained".into());
                }
                let current = futo_notes_core::files::vault_fs::read(root, &destination)?;
                if !intent
                    .expected_disk
                    .iter()
                    .any(|expected| expected.as_bytes() == current)
                {
                    return Err("identity outcome is ambiguous; original draft retained".into());
                }
                complete(root, &path, storage)?;
                cleanup(root, &path, storage)?;
            }
        }
        Ok(())
    }
}
fn validate(root: &Path, intent: &Intent) -> Result<(), String> {
    crate::paths::note_path(root, &intent.header.id)?;
    crate::paths::note_path(root, &intent.destination)?;
    if intent.header.vault
        != root
            .canonicalize()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
    {
        return Err("identity intent belongs to another vault".into());
    }
    Ok(())
}
fn complete(
    root: &Path,
    path: &str,
    storage: &mut dyn RecoveryStorage,
) -> Result<Decision, String> {
    let decision_path = format!("{path}.committed");
    let decision: Decision = if let Some(bytes) = storage.read(root, &decision_path)? {
        decode(&bytes)?
    } else {
        let bytes = storage
            .read(root, path)?
            .ok_or("identity intent disappeared")?;
        let intent: Intent = decode(&bytes)?;
        validate(root, &intent)?;
        let mut header = intent.header.clone();
        header.id = intent.destination.clone();
        let epoch =
            futo_notes_core::files::recovery_coordination::replacement_epoch(root, &header.id)?;
        // Preserve a source's prior intentional replacement across its own move.
        // Every controlled destination install after a real recovery directory
        // exists advances this counter; zero retains that earlier observation.
        header.replacement_epoch = if intent.replaced {
            if epoch == 0 {
                return Err("replacement observation cannot be transferred".into());
            }
            0
        } else {
            epoch
        };
        let mut stream = format::encode(&header)?;
        stream.extend_from_slice(&intent.records);
        let decision = Decision {
            intent,
            header,
            stream,
        };
        storage.create(root, &decision_path, &format::encode(&decision)?)?;
        storage.flush(root, &decision_path)?;
        decision
    };
    validate(root, &decision.intent)?;
    let destination = stream(&decision.header.id);
    if decision.intent.exists {
        match storage.read(root, &destination)? {
            None => storage.create(root, &destination, &decision.stream)?,
            Some(bytes) if bytes == decision.stream => {}
            Some(_) => {
                return Err(
                    "identity destination has another recovery stream; both retained".into(),
                )
            }
        }
        storage.flush(root, &destination)?;
        storage.remove(root, &stream(&decision.intent.header.id))?;
    }
    Ok(decision)
}
fn cleanup(root: &Path, path: &str, storage: &mut dyn RecoveryStorage) -> Result<(), String> {
    storage.remove(root, path)?;
    storage.remove(root, &format!("{path}.committed"))
}
