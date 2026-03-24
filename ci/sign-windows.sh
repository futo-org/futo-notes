#!/usr/bin/env bash
set -euo pipefail

# Windows code signing via jsign + AWS KMS.
# Based on FCast's signing flow:
# https://gitlab.futo.org/videostreaming/fcast-internal/-/blob/main/ci/sign.sh

FILE="${1:?Usage: sign-windows.sh <file>}"
CERT_FILE="${CERT_FILE:-/deploy/signing/fullchain.pem}"
AWS_REGION="${WINDOWS_SIGN_AWS_REGION:-us-east-1}"
AWS_ALIAS="${WINDOWS_SIGN_AWS_ALIAS:-FUTO-EV-signing-key}"
TSA_URL="${WINDOWS_SIGN_TSA_URL:-http://timestamp.globalsign.com/tsa/r6advanced1}"
JSIGN_VERSION="${JSIGN_VERSION:-7.4}"
JSIGN_JAR="${JSIGN_JAR:-$PWD/.ci-cache/jsign/jsign-cli-${JSIGN_VERSION}.jar}"

if [ ! -f "$FILE" ]; then
  echo "ERROR: File not found: $FILE" >&2
  exit 1
fi

if [ ! -f "$CERT_FILE" ]; then
  echo "ERROR: Certificate chain not found: $CERT_FILE" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is required for Windows signing" >&2
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: java is required for Windows signing" >&2
  exit 1
fi

mkdir -p "$(dirname "$JSIGN_JAR")"
if [ ! -f "$JSIGN_JAR" ]; then
  curl -fsSL "https://repo1.maven.org/maven2/net/jsign/jsign-cli/${JSIGN_VERSION}/jsign-cli-${JSIGN_VERSION}.jar" -o "$JSIGN_JAR"
fi

echo "Obtaining temporary AWS credentials..."
session="$(aws sts get-session-token --duration-seconds 900)"

AWS_ACCESS_KEY_ID="$(printf '%s' "$session" | jq -r '.Credentials.AccessKeyId')"
AWS_SECRET_ACCESS_KEY="$(printf '%s' "$session" | jq -r '.Credentials.SecretAccessKey')"
AWS_SESSION_TOKEN="$(printf '%s' "$session" | jq -r '.Credentials.SessionToken')"

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ "$AWS_ACCESS_KEY_ID" = "null" ]; then
  echo "ERROR: Failed to obtain temporary AWS credentials" >&2
  exit 1
fi

echo "Signing $FILE..."
AWS_USE_FIPS_ENDPOINT=true java -jar "$JSIGN_JAR" \
  --storetype AWS \
  --keystore "$AWS_REGION" \
  --storepass "$AWS_ACCESS_KEY_ID|$AWS_SECRET_ACCESS_KEY|$AWS_SESSION_TOKEN" \
  --alias "$AWS_ALIAS" \
  --tsaurl "$TSA_URL" \
  --tsmode RFC3161 \
  --certfile "$CERT_FILE" \
  "$FILE"

python - "$FILE" <<'PY'
import struct
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = path.read_bytes()
pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
optional_offset = pe_offset + 24
magic = struct.unpack_from("<H", data, optional_offset)[0]

if magic == 0x10B:
    data_dir_offset = optional_offset + 96
elif magic == 0x20B:
    data_dir_offset = optional_offset + 112
else:
    raise SystemExit(f"unknown PE optional header magic: {magic:#x}")

cert_offset, cert_size = struct.unpack_from("<II", data, data_dir_offset + (8 * 4))
if cert_offset == 0 or cert_size == 0:
    raise SystemExit("signed artifact is missing an Authenticode certificate table")

print(f"embedded Authenticode certificate table: offset={cert_offset} size={cert_size}")
PY

echo "Signed: $FILE"
