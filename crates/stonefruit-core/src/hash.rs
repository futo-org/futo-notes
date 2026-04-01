use sha2::{Digest, Sha256};

/// Compute SHA-256 hash of a UTF-8 string, returned as lowercase hex.
pub fn hash_sha256(content: &str) -> String {
    hash_sha256_bytes(content.as_bytes())
}

/// Compute SHA-256 hash of raw bytes, returned as lowercase hex.
pub fn hash_sha256_bytes(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
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
