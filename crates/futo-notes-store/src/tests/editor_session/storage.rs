use super::*;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Open,
    Create,
    IdentityDecision,
    Append,
    ShortWrite,
    Flush,
    Truncate,
    Retire,
    RetireSync,
}

#[derive(Default)]
pub struct Disk {
    pub accepted: HashMap<String, Vec<u8>>,
    pub durable: HashMap<String, Vec<u8>>,
    pub fault: Option<Fault>,
}

impl Disk {
    pub fn power_loss(&mut self) {
        self.accepted = self.durable.clone();
    }
}

pub struct FaultStorage(pub Arc<Mutex<Disk>>);

impl RecoveryStorage for FaultStorage {
    fn list(&mut self, _: &Path) -> Result<Vec<String>, String> {
        Ok(self.0.lock().unwrap().accepted.keys().cloned().collect())
    }
    fn read(&mut self, _: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
        let disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Open) {
            return Err("injected open failure".into());
        }
        Ok(disk.accepted.get(path).cloned())
    }
    fn create(&mut self, _: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Create)
            || (disk.fault == Some(Fault::IdentityDecision)
                && path.ends_with(".retarget.committed"))
        {
            return Err("injected create failure".into());
        }
        if disk.accepted.contains_key(path) {
            return Err("already exists".into());
        }
        disk.accepted.insert(path.to_owned(), bytes.to_vec());
        Ok(())
    }
    fn replace(&mut self, _: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Create) {
            return Err("injected replace failure".into());
        }
        disk.accepted.insert(path.to_owned(), bytes.to_vec());
        Ok(())
    }
    fn append(&mut self, _: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Append) {
            return Err("injected append failure".into());
        }
        if disk.fault == Some(Fault::ShortWrite) {
            disk.accepted
                .get_mut(path)
                .unwrap()
                .extend_from_slice(&bytes[..bytes.len() / 2]);
            return Err("injected short write".into());
        }
        disk.accepted
            .get_mut(path)
            .unwrap()
            .extend_from_slice(bytes);
        Ok(())
    }
    fn truncate(&mut self, _: &Path, path: &str, length: u64) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Truncate) {
            return Err("injected repair failure".into());
        }
        disk.accepted
            .get_mut(path)
            .ok_or("missing log")?
            .truncate(length as usize);
        Ok(())
    }
    fn flush(&mut self, _: &Path, path: &str) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Flush) {
            return Err("injected flush failure".into());
        }
        let bytes = disk.accepted.get(path).ok_or("missing log")?.clone();
        disk.durable.insert(path.to_owned(), bytes);
        Ok(())
    }
    fn remove(&mut self, _: &Path, path: &str) -> Result<(), String> {
        let mut disk = self.0.lock().unwrap();
        if disk.fault == Some(Fault::Retire) {
            return Err("injected retirement failure".into());
        }
        disk.accepted.remove(path);
        if disk.fault == Some(Fault::RetireSync) {
            return Err("injected retirement directory flush failure".into());
        }
        disk.durable.remove(path);
        Ok(())
    }
}

pub fn options(disk: &Arc<Mutex<Disk>>) -> RecoveryOptions {
    RecoveryOptions {
        storage: Box::new(FaultStorage(disk.clone())),
        ..RecoveryOptions::default()
    }
}
