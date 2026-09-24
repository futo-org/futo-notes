use sha2::{Digest, Sha256};

pub fn hash_sha256(content: &str) -> String {
    hash_sha256_bytes(content.as_bytes())
}

pub fn hash_sha256_bytes(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
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
    fn content_with_bom_utf8() {
        let with_bom = "\u{FEFF}hello";
        let without_bom = "hello";
        let h1 = hash_sha256(with_bom);
        let h2 = hash_sha256(without_bom);
        assert_ne!(h1, h2, "BOM should produce a different hash");
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn content_with_bom_utf16_bytes() {
        let data_with_bom = b"\xFF\xFEh\x00e\x00l\x00l\x00o\x00";
        let data_without_bom = b"h\x00e\x00l\x00l\x00o\x00";
        let h1 = hash_sha256_bytes(data_with_bom);
        let h2 = hash_sha256_bytes(data_without_bom);
        assert_ne!(h1, h2);
    }

    #[test]
    fn null_bytes_in_content() {
        let content = "hello\x00world";
        let result = hash_sha256(content);
        assert_eq!(result.len(), 64);
        assert_ne!(result, hash_sha256("helloworld"));
    }

    #[test]
    fn mixed_line_endings() {
        let unix = hash_sha256("line1\nline2");
        let windows = hash_sha256("line1\r\nline2");
        let old_mac = hash_sha256("line1\rline2");
        assert_ne!(unix, windows);
        assert_ne!(unix, old_mac);
        assert_ne!(windows, old_mac);
    }
}
