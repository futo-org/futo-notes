use sha2::{Digest, Sha256};

/// Compute SHA-256 hash of a UTF-8 string, returned as lowercase hex.
pub fn hash_sha256(content: &str) -> String {
    hash_sha256_bytes(content.as_bytes())
}

/// Compute SHA-256 hash of raw bytes, returned as lowercase hex.
pub fn hash_sha256_bytes(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    // Encode 32 digest bytes into a single 64-byte String. The previous
    // `iter().map(|b| format!("{b:02x}")).collect()` allocated 32 tiny
    // Strings per call (one per byte) plus the final concat — sync hashes
    // every changed note, so this matters when a vault is dirty.
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut buf = vec![0u8; digest.len() * 2];
    for (i, byte) in digest.iter().enumerate() {
        buf[i * 2] = HEX[(byte >> 4) as usize];
        buf[i * 2 + 1] = HEX[(byte & 0x0f) as usize];
    }
    // SAFETY: buf was constructed exclusively from ASCII hex digits.
    unsafe { String::from_utf8_unchecked(buf) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector() {
        assert_eq!(
            hash_sha256("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn empty_string() {
        assert_eq!(
            hash_sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn bytes_matches_string() {
        let content = "test content";
        assert_eq!(hash_sha256(content), hash_sha256_bytes(content.as_bytes()));
    }

    #[test]
    fn unicode() {
        // Just verify it doesn't panic and produces a 64-char hex string
        let result = hash_sha256("café ☕ 日本語");
        assert_eq!(result.len(), 64);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // ── Adversarial tests ──────────────────────────────────────────────

    #[test]
    fn large_content_1mb() {
        let content = "a".repeat(1_000_000);
        let result = hash_sha256(&content);
        assert_eq!(result.len(), 64);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));
        // Same content must produce same hash
        assert_eq!(result, hash_sha256(&content));
    }

    #[test]
    fn large_content_bytes_1mb() {
        let data = vec![0xFFu8; 1_000_000];
        let result = hash_sha256_bytes(&data);
        assert_eq!(result.len(), 64);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn binary_looking_content() {
        // String containing escape sequences that look like binary
        let content = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f";
        let result = hash_sha256(content);
        assert_eq!(result.len(), 64);
    }

    #[test]
    fn binary_bytes_all_values() {
        // Every possible byte value
        let data: Vec<u8> = (0..=255).collect();
        let result = hash_sha256_bytes(&data);
        assert_eq!(result.len(), 64);
    }

    #[test]
    fn content_with_bom_utf8() {
        let with_bom = "\u{FEFF}hello";
        let without_bom = "hello";
        let h1 = hash_sha256(with_bom);
        let h2 = hash_sha256(without_bom);
        // BOM is a real character — hashes MUST differ
        assert_ne!(h1, h2, "BOM should produce a different hash");
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn content_with_bom_utf16_bytes() {
        // UTF-16 LE BOM as raw bytes
        let data_with_bom = b"\xFF\xFEh\x00e\x00l\x00l\x00o\x00";
        let data_without_bom = b"h\x00e\x00l\x00l\x00o\x00";
        let h1 = hash_sha256_bytes(data_with_bom);
        let h2 = hash_sha256_bytes(data_without_bom);
        assert_ne!(h1, h2);
    }

    #[test]
    fn deterministic_across_calls() {
        let content = "determinism test 🔒";
        let h1 = hash_sha256(content);
        let h2 = hash_sha256(content);
        let h3 = hash_sha256(content);
        assert_eq!(h1, h2);
        assert_eq!(h2, h3);
    }

    #[test]
    fn single_char_differences() {
        // Changing a single character should produce completely different hashes
        let h1 = hash_sha256("abc");
        let h2 = hash_sha256("abd");
        assert_ne!(h1, h2);
    }

    #[test]
    fn null_bytes_in_content() {
        let content = "hello\x00world";
        let result = hash_sha256(content);
        assert_eq!(result.len(), 64);
        // Different from without null
        assert_ne!(result, hash_sha256("helloworld"));
    }

    #[test]
    fn whitespace_only_content() {
        let spaces = hash_sha256("   ");
        let tabs = hash_sha256("\t\t\t");
        let newlines = hash_sha256("\n\n\n");
        let empty = hash_sha256("");
        // All should be valid and distinct
        assert_eq!(spaces.len(), 64);
        assert_ne!(spaces, tabs);
        assert_ne!(spaces, newlines);
        assert_ne!(spaces, empty);
    }

    // Old implementation, kept as a baseline for the bench tests below.
    // 32 small String allocations per call + a concat into a final String.
    fn hash_sha256_bytes_old(data: &[u8]) -> String {
        let digest = Sha256::digest(data);
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    }

    // Run with: cargo test -p futo-notes-core --release bench_hash -- --ignored --nocapture
    // Prints wall-clock for 100k hash calls so we can see allocation cost.
    fn time_hash<F: Fn(&[u8]) -> String>(label: &str, data: &[u8], iters: usize, f: F) {
        // Warmup
        for _ in 0..(iters / 10).max(1) {
            std::hint::black_box(f(data));
        }
        let start = std::time::Instant::now();
        let mut sink = 0u64;
        for _ in 0..iters {
            let h = f(data);
            sink = sink.wrapping_add(h.as_bytes()[0] as u64);
        }
        let elapsed = start.elapsed();
        eprintln!(
            "{label:25} {iters} iters in {:.3}ms ({:.2}ns/op) sink={sink}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_nanos() as f64 / iters as f64,
        );
    }

    #[test]
    #[ignore = "perf benchmark - run with --release --nocapture"]
    fn bench_hash_small() {
        let content = b"a short note line\nwith a couple paragraphs\nand a wikilink [[foo]]";
        let iters = 200_000;
        time_hash("hash_sha256_old   small", content, iters, hash_sha256_bytes_old);
        time_hash("hash_sha256       small", content, iters, hash_sha256_bytes);
    }

    #[test]
    #[ignore = "perf benchmark - run with --release --nocapture"]
    fn bench_hash_4kb() {
        let content = vec![b'x'; 4096];
        let iters = 50_000;
        time_hash("hash_sha256_old   4KB  ", &content, iters, hash_sha256_bytes_old);
        time_hash("hash_sha256       4KB  ", &content, iters, hash_sha256_bytes);
    }

    #[test]
    #[ignore = "perf benchmark - run with --release --nocapture"]
    fn bench_hash_64kb() {
        let content = vec![b'x'; 64 * 1024];
        let iters = 5_000;
        time_hash("hash_sha256_old   64KB ", &content, iters, hash_sha256_bytes_old);
        time_hash("hash_sha256       64KB ", &content, iters, hash_sha256_bytes);
    }

    #[test]
    fn mixed_line_endings() {
        let unix = hash_sha256("line1\nline2");
        let windows = hash_sha256("line1\r\nline2");
        let old_mac = hash_sha256("line1\rline2");
        // All must be different — no line ending normalization
        assert_ne!(unix, windows);
        assert_ne!(unix, old_mac);
        assert_ne!(windows, old_mac);
    }
}
