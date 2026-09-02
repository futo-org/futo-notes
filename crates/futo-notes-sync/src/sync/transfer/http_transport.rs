mod download_batch;
mod download_single;
mod upload;
mod upload_batch;

use crate::server::Object;
use crate::sync::{FailureKind, SyncFailure};

use super::DownloadedObject;

#[cfg(test)]
#[path = "http_transport/upload_tests.rs"]
mod upload_tests;

pub(super) use download_batch::run_batch_downloads;
#[cfg(test)]
pub(super) use download_batch::run_batch_job;
pub(super) use download_single::run_single_downloads;
pub(in crate::sync) use upload::dispatch_one_upload;
pub(super) use upload::UploadDispatcher;

fn download_failure(
    object: Object,
    status_code: Option<u16>,
    detail: impl Into<String>,
) -> DownloadedObject {
    (
        object,
        Err(SyncFailure {
            filename: String::new(),
            kind: FailureKind::Download,
            status_code,
            detail: Some(detail.into()),
        }),
    )
}
