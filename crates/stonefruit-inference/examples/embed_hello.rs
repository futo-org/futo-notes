//! Phase 1 desktop smoke test.
//!
//! Downloads nomic-embed-text-v1.5 (INT8 ONNX + tokenizer) into a scratch dir,
//! loads an [`Embedder`], embeds a fixed string and a batch of 32, then prints
//! timings + the first 8 dims of the vector so we can eyeball that it's not
//! all-zeros / NaN.
//!
//! Run:
//!
//! ```ignore
//! cargo run -p stonefruit-inference --example embed_hello
//! ```
//!
//! Override the cache location with `MODEL_DIR=/path/to/dir`.

use std::env;
use std::path::PathBuf;
use std::time::Instant;

use stonefruit_inference::{
    download_to, DownloadTarget, Embedder, NOMIC_V15_DIMS, NOMIC_V15_MODEL_URL,
    NOMIC_V15_TOKENIZER_URL,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model_dir: PathBuf = env::var("MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir().join("stonefruit-inference-demo"));
    std::fs::create_dir_all(&model_dir)?;

    let model_path = model_dir.join("model_quantized.onnx");
    let tokenizer_path = model_dir.join("tokenizer.json");

    if !model_path.exists() {
        println!("downloading model → {}", model_path.display());
        download_to(&DownloadTarget {
            url: NOMIC_V15_MODEL_URL.into(),
            dest: model_path.clone(),
            sha256: None,
        })?;
    }
    if !tokenizer_path.exists() {
        println!("downloading tokenizer → {}", tokenizer_path.display());
        download_to(&DownloadTarget {
            url: NOMIC_V15_TOKENIZER_URL.into(),
            dest: tokenizer_path.clone(),
            sha256: None,
        })?;
    }

    println!("loading embedder...");
    let load_start = Instant::now();
    let mut embedder = Embedder::load(&model_path, &tokenizer_path, NOMIC_V15_DIMS)?;
    println!("load: {:?}", load_start.elapsed());

    let text = "The quick brown fox jumps over the lazy dog.";
    let t = Instant::now();
    let v = embedder.embed(text)?;
    let dt = t.elapsed();
    println!(
        "embed(1) in {dt:?} — dims={} first_8={:?}",
        v.len(),
        &v[..8.min(v.len())]
    );

    // Batch of 32 — Phase 1 ship threshold is <500ms.
    let batch: Vec<&str> = (0..32).map(|_| text).collect();
    let t = Instant::now();
    let vs = embedder.embed_batch(&batch)?;
    let dt = t.elapsed();
    println!(
        "embed_batch({}) in {dt:?} (~{:?} each)",
        vs.len(),
        dt / vs.len() as u32
    );

    // Sanity: query vs document embeddings for semantically related text should
    // be closer than unrelated text. Not an assertion — just a visual check.
    let q = embedder.embed_query("a fast animal")?;
    let d_related = embedder.embed("A cheetah sprints across the savannah.")?;
    let d_unrelated = embedder.embed("Tax deadline is April 15.")?;
    println!(
        "cosine(query, related)={:.4} cosine(query, unrelated)={:.4}",
        dot(&q, &d_related),
        dot(&q, &d_unrelated)
    );

    Ok(())
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}
