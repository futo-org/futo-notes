//! Resumable HTTP download with SHA-256 verification.
//!
//! Writes to `<dest>.part` incrementally, renames atomically on success, and
//! sends an HTTP Range header so a partial file survives app kills. No
//! progress reporting yet — that wires in during Phase 4 when a Tauri command
//! needs to emit events.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::Error;

/// What to download. `sha256` is optional: if present, the existing file is
/// hashed first and the download is skipped entirely on match; otherwise the
/// downloaded `.part` is verified before rename.
#[derive(Debug, Clone)]
pub struct DownloadTarget {
    pub url: String,
    pub dest: PathBuf,
    pub sha256: Option<String>,
}

/// Download `target.url` to `target.dest`. Resumes a previous `.part` if one
/// exists. Verifies SHA-256 when provided.
pub fn download_to(target: &DownloadTarget) -> crate::Result<()> {
    if let Some(expected) = &target.sha256 {
        if target.dest.exists() && verify_sha256(&target.dest, expected)? {
            return Ok(());
        }
    } else if target.dest.exists() {
        // No integrity info; assume a prior successful download.
        return Ok(());
    }

    if let Some(parent) = target.dest.parent() {
        fs::create_dir_all(parent)?;
    }

    let part = part_path(&target.dest);
    let existing_bytes = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::blocking::Client::builder()
        // No overall timeout — model files are large and may legitimately
        // take many seconds. `connect_timeout` guards against DNS/SYN stalls.
        .timeout(None)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::Http(e.to_string()))?;

    let mut req = client.get(&target.url);
    if existing_bytes > 0 {
        req = req.header("Range", format!("bytes={existing_bytes}-"));
    }
    let mut resp = req.send().map_err(|e| Error::Http(e.to_string()))?;

    let status = resp.status();
    if !(status.is_success() || status.as_u16() == 206) {
        return Err(Error::Http(format!("HTTP {status}")));
    }

    // If the server returned 200 with no Range support, start over.
    let open_mode_append = existing_bytes > 0 && status.as_u16() == 206;
    let mut file = if open_mode_append {
        OpenOptions::new().append(true).open(&part)?
    } else {
        File::create(&part)?
    };

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| Error::Http(format!("read body: {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
    }
    file.flush()?;
    drop(file);

    if let Some(expected) = &target.sha256 {
        if !verify_sha256(&part, expected)? {
            // Leave the .part in place so we can retry without re-downloading
            // from zero; the next call will hit the Range branch. A corrupt
            // byte range is rare and usually indicates server-side corruption,
            // which re-requesting won't fix, but we prefer to preserve bytes
            // over discarding them.
            return Err(Error::HashMismatch);
        }
    }

    fs::rename(&part, &target.dest)?;
    Ok(())
}

/// Compute SHA-256 of a file and compare to a hex string. Case-insensitive.
pub fn verify_sha256(path: &Path, expected_hex: &str) -> crate::Result<bool> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let got = hex_encode(&hasher.finalize());
    Ok(got.eq_ignore_ascii_case(expected_hex))
}

fn part_path(dest: &Path) -> PathBuf {
    let mut p = dest.to_path_buf();
    let file_name = match p.file_name() {
        Some(n) => n.to_os_string(),
        None => return dest.with_extension("part"),
    };
    let mut new_name = file_name;
    new_name.push(".part");
    p.set_file_name(new_name);
    p
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encode_roundtrip() {
        assert_eq!(hex_encode(&[0x00, 0xff, 0xab, 0xcd]), "00ffabcd");
    }

    #[test]
    fn part_path_appends_extension() {
        assert_eq!(
            part_path(Path::new("/tmp/model.onnx")),
            PathBuf::from("/tmp/model.onnx.part")
        );
        assert_eq!(
            part_path(Path::new("/tmp/no_ext")),
            PathBuf::from("/tmp/no_ext.part")
        );
    }

    #[test]
    fn verify_sha256_matches() {
        // Use CARGO_MANIFEST_DIR rather than std::env::temp_dir() — on
        // machines with a tmpfs user-quota enabled, /tmp can refuse writes
        // while /home has plenty of headroom, which is confusing to debug.
        let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let test_dir = manifest.join("target").join("test-tmp");
        std::fs::create_dir_all(&test_dir).expect("create test-tmp dir");
        let tmp = test_dir.join(format!("sf-inf-verify-{}", std::process::id()));
        std::fs::write(&tmp, b"hello world").expect("write test fixture");
        // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        let ok = verify_sha256(
            &tmp,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        )
        .unwrap();
        let mismatch = verify_sha256(&tmp, "deadbeef").unwrap();
        std::fs::remove_file(&tmp).ok();
        assert!(ok);
        assert!(!mismatch);
    }
}
