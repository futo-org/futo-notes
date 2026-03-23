#!/bin/bash
# Windows code signing via jsign + AWS KMS (FUTO EV signing key)
# Usage: ./ci/sign-windows.sh <file-to-sign>
#
# Requires:
#   - AWS credentials configured (env vars or ~/.aws/credentials)
#   - jsign installed
#   - fullchain.pem at $CERT_FILE (default: /deploy/signing/fullchain.pem)
#
# Based on FCast's signing flow:
#   https://gitlab.futo.org/videostreaming/fcast-internal/-/blob/main/ci/sign.sh

set -euo pipefail

FILE="${1:?Usage: sign-windows.sh <file>}"
CERT_FILE="${CERT_FILE:-/deploy/signing/fullchain.pem}"

if [ ! -f "$FILE" ]; then
  echo "ERROR: File not found: $FILE"
  exit 1
fi

if [ ! -f "$CERT_FILE" ]; then
  echo "ERROR: Certificate chain not found: $CERT_FILE"
  echo "Download fullchain.pem from GitLab secure files first."
  exit 1
fi

echo "Obtaining temporary AWS credentials..."
session=$(aws sts get-session-token --duration-seconds 900)

export AWS_ACCESS_KEY_ID=$(echo "$session" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$session" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$session" | jq -r '.Credentials.SessionToken')

echo "Signing $FILE..."
AWS_USE_FIPS_ENDPOINT=true jsign \
  --storetype AWS \
  --keystore us-east-1 \
  --storepass "$AWS_ACCESS_KEY_ID|$AWS_SECRET_ACCESS_KEY|$AWS_SESSION_TOKEN" \
  --alias "FUTO-EV-signing-key" \
  --tsaurl http://timestamp.globalsign.com/tsa/r6advanced1 \
  --tsmode RFC3161 \
  --certfile "$CERT_FILE" \
  "$FILE"

echo "Signed: $FILE"
