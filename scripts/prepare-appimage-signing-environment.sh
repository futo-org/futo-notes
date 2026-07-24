# Source this before any AppImage install, download, or build command.
# Tag pipelines retain the production key only as a non-exported shell value
# for the final signer. MR pipelines discard any unexpectedly available
# protected value and later use the non-production localdev fixture key.
unset RELEASE_SIGNING_KEY SIGNING_KEY
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  RELEASE_SIGNING_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}"
fi

unset TAURI_SIGNING_PRIVATE_KEY
unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
