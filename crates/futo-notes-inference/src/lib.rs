//! On-device text embedding for FUTO Notes.
//!
//! This crate wraps an ONNX Runtime session and a HuggingFace tokenizer behind
//! a concrete [`Embedder`] struct. It is the building block for client-side
//! semantic search and, eventually, local LLM features — but the abstraction
//! stays deliberately thin: no trait between us and `ort::Session` until a
//! second concrete implementation actually lands.
//!
//! # Phase 1 scope
//!
//! - Load a `model.onnx` + `tokenizer.json` pair from disk.
//! - Embed a single string or a batch.
//! - Resumable HTTP download with SHA-256 verification.
//!
//! Progress reporting, cancellation, background indexing, and Tauri wiring live
//! in later phases.

mod download;
mod embedder;

pub use download::{download_to, verify_sha256, DownloadTarget};
pub use embedder::{Embedder, Error, Result};

/// Identifier of the starter model. Keep this in a central place so UI +
/// download code + indexer all agree.
pub const NOMIC_V15_MODEL_ID: &str = "nomic-embed-text-v1.5";

/// Output dimensionality of `nomic-embed-text-v1.5`. The model also supports
/// Matryoshka truncation to 512/384/256/128 — we default to full 768 for
/// Phase 1 and revisit on mobile.
pub const NOMIC_V15_DIMS: usize = 768;

/// Prefix applied when embedding document text. Nomic models are trained with
/// these instruction prefixes — omitting them measurably degrades quality.
pub const NOMIC_DOCUMENT_PREFIX: &str = "search_document: ";

/// Prefix applied when embedding a search query.
pub const NOMIC_QUERY_PREFIX: &str = "search_query: ";

/// Hugging Face URL for the INT8-quantized ONNX file (~35 MB).
///
/// `resolve/main` returns the file contents directly (as opposed to `blob/main`
/// which returns an HTML page).
pub const NOMIC_V15_MODEL_URL: &str =
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx";

/// Hugging Face URL for the matching tokenizer.
pub const NOMIC_V15_TOKENIZER_URL: &str =
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json";
