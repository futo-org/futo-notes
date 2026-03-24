#!/usr/bin/env bash
set -euo pipefail

# Windows code signing via jsign + AWS KMS.
# Based on FCast's signing flow:
# https://gitlab.futo.org/videostreaming/fcast-internal/-/blob/main/ci/sign.sh

PROBE_ONLY=0
if [ "${1:-}" = "--probe-env" ]; then
  PROBE_ONLY=1
  FILE=""
else
  FILE="${1:?Usage: sign-windows.sh <file>}"
fi
CERT_FILE="${CERT_FILE:-/deploy/signing/fullchain.pem}"
AWS_REGION="${WINDOWS_SIGN_AWS_REGION:-us-east-1}"
AWS_ALIAS="${WINDOWS_SIGN_AWS_ALIAS:-FUTO-EV-signing-key}"
TSA_URL="${WINDOWS_SIGN_TSA_URL:-http://timestamp.globalsign.com/tsa/r6advanced1}"
JSIGN_VERSION="${JSIGN_VERSION:-7.4}"
JSIGN_JAR="${JSIGN_JAR:-$PWD/.ci-cache/jsign/jsign-${JSIGN_VERSION}.jar}"

if [ "$PROBE_ONLY" -eq 0 ]; then
  if [ ! -f "$FILE" ]; then
    echo "ERROR: File not found: $FILE" >&2
    exit 1
  fi

  if [ ! -f "$CERT_FILE" ]; then
    echo "ERROR: Certificate chain not found: $CERT_FILE" >&2
    exit 1
  fi
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is required for Windows signing" >&2
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: java is required for Windows signing" >&2
  exit 1
fi

resolve_env_value() {
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN=python3
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN=python
  else
    echo "ERROR: python3 or python is required to verify the signed artifact" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$JSIGN_JAR")"
if [ ! -f "$JSIGN_JAR" ]; then
  # Use the official all-in-one JAR published on GitHub releases.
  curl -fsSL "https://github.com/ebourg/jsign/releases/download/${JSIGN_VERSION}/jsign-${JSIGN_VERSION}.jar" -o "$JSIGN_JAR"
fi

if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  AWS_ACCESS_KEY_ID="$(resolve_env_value WINDOWS_SIGN_AWS_ACCESS_KEY_ID WINDOWS_SIGN_ACCESS_KEY_ID AWS_ACCESS_KEY_ID AWS_ACCESS_KEY || true)"
fi

if [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  AWS_SECRET_ACCESS_KEY="$(resolve_env_value WINDOWS_SIGN_AWS_SECRET_ACCESS_KEY WINDOWS_SIGN_SECRET_ACCESS_KEY AWS_SECRET_ACCESS_KEY AWS_SECRET_KEY || true)"
fi

if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
  AWS_SESSION_TOKEN="$(resolve_env_value WINDOWS_SIGN_AWS_SESSION_TOKEN WINDOWS_SIGN_SESSION_TOKEN AWS_SESSION_TOKEN || true)"
fi

if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "ERROR: AWS signing credentials are not available in the CI job environment" >&2
  echo "Visible candidate env var names:" >&2
  env | cut -d= -f1 | grep -E '^(AWS|WINDOWS_SIGN|KMS|SIGNING_)' | sort >&2 || true
  exit 1
fi

if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
  echo "Obtaining temporary AWS credentials..."
  session="$(
    AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
    aws sts get-session-token --duration-seconds 900
  )"

  AWS_ACCESS_KEY_ID="$(printf '%s' "$session" | jq -r '.Credentials.AccessKeyId')"
  AWS_SECRET_ACCESS_KEY="$(printf '%s' "$session" | jq -r '.Credentials.SecretAccessKey')"
  AWS_SESSION_TOKEN="$(printf '%s' "$session" | jq -r '.Credentials.SessionToken')"
fi

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ "$AWS_ACCESS_KEY_ID" = "null" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ "$AWS_SECRET_ACCESS_KEY" = "null" ] || [ -z "$AWS_SESSION_TOKEN" ] || [ "$AWS_SESSION_TOKEN" = "null" ]; then
  echo "ERROR: Failed to obtain usable temporary AWS credentials" >&2
  exit 1
fi

if [ "$PROBE_ONLY" -eq 1 ]; then
  echo "AWS signing credentials resolved successfully"
  exit 0
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

"$PYTHON_BIN" - "$FILE" <<'PY'
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
