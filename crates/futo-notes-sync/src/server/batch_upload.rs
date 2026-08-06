use serde::Deserialize;

use super::{number, Conflict, HttpError, Object, Write};

pub(crate) enum BatchWriteOperation {
    Create { mutation_id: String },
    Update { object_id: String, version: u64 },
}

pub(crate) struct BatchWriteEntry {
    pub operation: BatchWriteOperation,
    pub ciphertext: Vec<u8>,
}

pub(crate) fn batch_write_frame_size(object_id: &str, ciphertext_len: usize) -> Option<u64> {
    u16::try_from(object_id.len()).ok()?;
    u32::try_from(ciphertext_len).ok()?;
    u64::try_from(
        11usize
            .checked_add(object_id.len())?
            .checked_add(ciphertext_len)?,
    )
    .ok()
}

#[derive(Debug)]
pub(crate) enum BatchMutation {
    Created(Write),
    Replayed(Write),
    Updated(Write),
    Conflict(Conflict),
    NotFound,
    TooLarge,
    Error(String),
}

pub(super) fn encode_batch_write_frames(entries: &[BatchWriteEntry]) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    for entry in entries {
        let (operation, identifier, version) = match &entry.operation {
            BatchWriteOperation::Create { mutation_id } => (0, mutation_id.as_str(), 0),
            BatchWriteOperation::Update { object_id, version } => {
                if *version == 0 {
                    return Err(HttpError {
                        status: None,
                        message: "batch update version must be at least 1".into(),
                    });
                }
                (1, object_id.as_str(), *version)
            }
        };
        let identifier_len = u16::try_from(identifier.len()).map_err(|_| HttpError {
            status: None,
            message: "batch identifier exceeds u16 framing".into(),
        })?;
        let ciphertext_len = u32::try_from(entry.ciphertext.len()).map_err(|_| HttpError {
            status: None,
            message: "batch ciphertext exceeds u32 framing".into(),
        })?;
        if ciphertext_len == 0 {
            return Err(HttpError {
                status: None,
                message: "batch ciphertext must not be empty".into(),
            });
        }
        let version = u32::try_from(version).map_err(|_| HttpError {
            status: None,
            message: "batch update version exceeds u32 framing".into(),
        })?;
        body.push(operation);
        body.extend_from_slice(&identifier_len.to_be_bytes());
        body.extend_from_slice(identifier.as_bytes());
        body.extend_from_slice(&version.to_be_bytes());
        body.extend_from_slice(&ciphertext_len.to_be_bytes());
        body.extend_from_slice(&entry.ciphertext);
    }
    Ok(body)
}

#[derive(Deserialize)]
struct BatchWriteBody {
    results: Vec<BatchWriteResultBody>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BatchWriteResultBody {
    Created {
        object: Object,
        #[serde(rename = "collectionVersion", deserialize_with = "number")]
        collection_version: u64,
    },
    Replayed {
        object: Object,
        #[serde(rename = "collectionVersion", deserialize_with = "number")]
        collection_version: u64,
    },
    Updated {
        object: Object,
        #[serde(rename = "collectionVersion", deserialize_with = "number")]
        collection_version: u64,
    },
    Conflict {
        #[serde(rename = "currentVersion", deserialize_with = "number")]
        current_version: u64,
        #[serde(rename = "currentBlobKey", default)]
        current_blob_key: Option<String>,
    },
    NotFound,
    TooLarge,
    Error {
        error: String,
    },
}

impl BatchWriteResultBody {
    fn status_name(&self) -> &'static str {
        match self {
            Self::Created { .. } => "created",
            Self::Replayed { .. } => "replayed",
            Self::Updated { .. } => "updated",
            Self::Conflict { .. } => "conflict",
            Self::NotFound => "not_found",
            Self::TooLarge => "too_large",
            Self::Error { .. } => "error",
        }
    }
}

impl From<BatchWriteResultBody> for BatchMutation {
    fn from(result: BatchWriteResultBody) -> Self {
        match result {
            BatchWriteResultBody::Created {
                object,
                collection_version,
            } => Self::Created(Write {
                object,
                collection_version,
            }),
            BatchWriteResultBody::Replayed {
                object,
                collection_version,
            } => Self::Replayed(Write {
                object,
                collection_version,
            }),
            BatchWriteResultBody::Updated {
                object,
                collection_version,
            } => Self::Updated(Write {
                object,
                collection_version,
            }),
            BatchWriteResultBody::Conflict {
                current_version,
                current_blob_key,
            } => Self::Conflict(Conflict {
                current_version,
                current_blob_key,
            }),
            BatchWriteResultBody::NotFound => Self::NotFound,
            BatchWriteResultBody::TooLarge => Self::TooLarge,
            BatchWriteResultBody::Error { error } => Self::Error(error),
        }
    }
}

pub(super) fn parse_batch_write_results(
    body: &[u8],
    entries: &[BatchWriteEntry],
) -> Result<Vec<BatchMutation>, HttpError> {
    let parsed = serde_json::from_slice::<BatchWriteBody>(body).map_err(|error| HttpError {
        status: None,
        message: error.to_string(),
    })?;
    if parsed.results.len() != entries.len() {
        return Err(HttpError {
            status: None,
            message: format!(
                "batch upload: expected {} results, got {}",
                entries.len(),
                parsed.results.len()
            ),
        });
    }
    parsed
        .results
        .into_iter()
        .zip(entries)
        .enumerate()
        .map(|(index, (result, entry))| {
            validate_batch_write_result(index, &result, entry)?;
            Ok(result.into())
        })
        .collect()
}

fn validate_batch_write_result(
    index: usize,
    result: &BatchWriteResultBody,
    entry: &BatchWriteEntry,
) -> Result<(), HttpError> {
    match &entry.operation {
        BatchWriteOperation::Create { .. } => validate_create_result(index, result),
        BatchWriteOperation::Update { object_id, .. } => {
            validate_update_result(index, object_id, result)
        }
    }
}

fn validate_create_result(index: usize, result: &BatchWriteResultBody) -> Result<(), HttpError> {
    match result {
        BatchWriteResultBody::Created { object, .. }
        | BatchWriteResultBody::Replayed { object, .. }
            if !object.id.is_empty() =>
        {
            Ok(())
        }
        BatchWriteResultBody::Created { .. } | BatchWriteResultBody::Replayed { .. } => Err(
            invalid_batch_result(index, "create returned an empty object id".into()),
        ),
        BatchWriteResultBody::TooLarge | BatchWriteResultBody::Error { .. } => Ok(()),
        _ => Err(incompatible_status(index, "create", result)),
    }
}

fn validate_update_result(
    index: usize,
    expected_object_id: &str,
    result: &BatchWriteResultBody,
) -> Result<(), HttpError> {
    match result {
        BatchWriteResultBody::Updated { object, .. } => {
            validate_response_object_id(index, expected_object_id, object)
        }
        BatchWriteResultBody::Conflict { .. }
        | BatchWriteResultBody::NotFound
        | BatchWriteResultBody::TooLarge
        | BatchWriteResultBody::Error { .. } => Ok(()),
        _ => Err(incompatible_status(index, "update", result)),
    }
}

fn validate_response_object_id(
    index: usize,
    expected_object_id: &str,
    object: &Object,
) -> Result<(), HttpError> {
    if object.id == expected_object_id {
        return Ok(());
    }
    Err(invalid_batch_result(
        index,
        format!("expected object {expected_object_id}, got {}", object.id),
    ))
}

fn incompatible_status(index: usize, operation: &str, result: &BatchWriteResultBody) -> HttpError {
    invalid_batch_result(
        index,
        format!(
            "status {} is incompatible with {operation}",
            result.status_name()
        ),
    )
}

fn invalid_batch_result(index: usize, message: String) -> HttpError {
    HttpError {
        status: None,
        message: format!("batch upload result {index}: {message}"),
    }
}

#[cfg(test)]
mod tests;
