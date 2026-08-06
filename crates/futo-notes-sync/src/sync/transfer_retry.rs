use std::time::Duration;

use crate::server::HttpError;

pub(super) const BATCH_RETRY_BACKOFF: [Duration; 2] =
    [Duration::from_millis(500), Duration::from_secs(2)];

#[derive(Debug, PartialEq, Eq)]
pub(super) enum BatchErrorAction {
    Unsupported,
    Retry(Duration),
    Degrade,
}

pub(super) fn batch_error_action(error: &HttpError, attempt: usize) -> BatchErrorAction {
    if matches!(error.status, Some(404 | 405 | 501)) {
        BatchErrorAction::Unsupported
    } else if is_retryable(error) && attempt < BATCH_RETRY_BACKOFF.len() {
        BatchErrorAction::Retry(BATCH_RETRY_BACKOFF[attempt])
    } else {
        BatchErrorAction::Degrade
    }
}

fn is_retryable(error: &HttpError) -> bool {
    match error.status {
        Some(status) => status >= 500 || status == 408 || status == 429,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_error_action_implements_404_flag_and_retry_degrade_ladder() {
        let error = |status| HttpError {
            status,
            message: "failure".into(),
        };
        assert_eq!(
            batch_error_action(&error(Some(404)), 0),
            BatchErrorAction::Unsupported
        );
        assert_eq!(
            batch_error_action(&error(Some(405)), 0),
            BatchErrorAction::Unsupported
        );
        assert_eq!(
            batch_error_action(&error(Some(501)), 0),
            BatchErrorAction::Unsupported
        );
        assert_eq!(
            batch_error_action(&error(Some(500)), 0),
            BatchErrorAction::Retry(Duration::from_millis(500))
        );
        assert_eq!(
            batch_error_action(&error(Some(500)), 1),
            BatchErrorAction::Retry(Duration::from_secs(2))
        );
        assert_eq!(
            batch_error_action(&error(Some(500)), 2),
            BatchErrorAction::Degrade
        );
        assert_eq!(
            batch_error_action(&error(Some(401)), 0),
            BatchErrorAction::Degrade
        );
        assert_eq!(
            batch_error_action(&error(None), 0),
            BatchErrorAction::Retry(Duration::from_millis(500))
        );
    }
}
