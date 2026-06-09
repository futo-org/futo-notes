//! Shared error type for the inference crate's ONNX Runtime sessions.

/// Errors produced by the encoder.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("ort: {0}")]
    Ort(String),

    #[error("tokenizer: {0}")]
    Tokenizer(String),

    #[error("shape: {0}")]
    Shape(String),

    #[error("model output `last_hidden_state` missing or wrong dtype")]
    BadModelOutput,
}

pub type Result<T> = std::result::Result<T, Error>;

// ort 2.0's `ort::Error<T>` is generic over a context tag (e.g. `SessionBuilder`),
// so we can't use `#[from]` — write a blanket conversion that stringifies any
// variant we encounter.
impl<T> From<ort::Error<T>> for Error {
    fn from(e: ort::Error<T>) -> Self {
        Error::Ort(e.to_string())
    }
}
