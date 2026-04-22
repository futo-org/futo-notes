//! Integration tests that exercise a real loaded model.
//!
//! These tests are skipped when `FUTO_NOTES_INFERENCE_TEST_MODEL` is unset, so
//! CI can run `cargo test` without a ~35MB model on disk. To run locally:
//!
//! ```sh
//! # First, populate a cache dir with model + tokenizer:
//! cargo run -p futo-notes-inference --example embed_hello
//! # Then:
//! FUTO_NOTES_INFERENCE_TEST_MODEL=/tmp/futo-notes-inference-demo \
//!     cargo test -p futo-notes-inference --tests
//! ```

use std::path::{Path, PathBuf};

use futo_notes_inference::{Embedder, NOMIC_V15_DIMS};

fn model_dir() -> Option<PathBuf> {
    std::env::var("FUTO_NOTES_INFERENCE_TEST_MODEL")
        .ok()
        .map(PathBuf::from)
        .filter(|p| {
            p.join("model_quantized.onnx").exists() && p.join("tokenizer.json").exists()
        })
}

fn load_embedder(dir: &Path) -> Embedder {
    Embedder::load(
        &dir.join("model_quantized.onnx"),
        &dir.join("tokenizer.json"),
        NOMIC_V15_DIMS,
    )
    .expect("embedder load")
}

#[test]
fn embed_produces_expected_dims() {
    let Some(dir) = model_dir() else {
        eprintln!("skipping: FUTO_NOTES_INFERENCE_TEST_MODEL not set or model missing");
        return;
    };
    let mut embedder = load_embedder(&dir);
    let v = embedder.embed("hello world").unwrap();
    assert_eq!(v.len(), NOMIC_V15_DIMS);
}

#[test]
fn embed_is_l2_normalized() {
    let Some(dir) = model_dir() else {
        return;
    };
    let mut embedder = load_embedder(&dir);
    let v = embedder.embed("check normalization").unwrap();
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 1e-3,
        "expected unit-norm vector, got norm={norm}"
    );
}

#[test]
fn embed_is_deterministic() {
    let Some(dir) = model_dir() else {
        return;
    };
    let mut embedder = load_embedder(&dir);
    let a = embedder.embed("deterministic inference").unwrap();
    let b = embedder.embed("deterministic inference").unwrap();
    assert_eq!(a.len(), b.len());
    for i in 0..a.len() {
        assert!(
            (a[i] - b[i]).abs() < 1e-5,
            "diff at dim {i}: {} vs {}",
            a[i],
            b[i]
        );
    }
}

#[test]
fn batch_matches_single_embeddings() {
    let Some(dir) = model_dir() else {
        return;
    };
    let mut embedder = load_embedder(&dir);
    let texts = ["alpha note", "beta note with more content", "gamma"];
    let single: Vec<_> = texts.iter().map(|t| embedder.embed(t).unwrap()).collect();
    let batch = embedder.embed_batch(&texts).unwrap();
    assert_eq!(single.len(), batch.len());
    for (idx, (s, b)) in single.iter().zip(batch.iter()).enumerate() {
        assert_eq!(s.len(), b.len());
        // Padding differs between single and batch calls: tokens get padded
        // to the longest sequence in the batch, and INT8 quantization noise
        // propagates slightly differently across different batch shapes. So
        // we can't assert bitwise (or even near-bitwise) equality — what
        // should hold is that the vectors still point in essentially the
        // same direction.
        let cos: f32 = s.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        assert!(
            cos > 0.98,
            "text {idx} ({}): batched vs single cosine={cos}",
            texts[idx]
        );
    }
}

#[test]
fn query_prefix_produces_different_vector() {
    let Some(dir) = model_dir() else {
        return;
    };
    let mut embedder = load_embedder(&dir);
    // Same text, different prefix → must yield different vectors. If they match,
    // we've accidentally applied the same prefix in both paths.
    let doc = embedder.embed("the boundary of distinct prefixes").unwrap();
    let q = embedder.embed_query("the boundary of distinct prefixes").unwrap();
    let cos: f32 = doc.iter().zip(q.iter()).map(|(x, y)| x * y).sum();
    assert!(cos < 0.9999, "prefixes had no effect (cos={cos})");
}
