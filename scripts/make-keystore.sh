#!/bin/bash
# One-time: generate the release keystore for MathMD signing.
# The keystore NEVER enters git (see .gitignore); upload its base64 to the
# GitHub repo secrets (RELEASE_KEYSTORE_B64 / RELEASE_KEYSTORE_PASS /
# RELEASE_KEY_ALIAS) to enable signed CI releases.
set -euo pipefail
KEYSTORE="${1:-mathmd-release.keystore}"
KS_PASS="${2:?usage: make-keystore.sh [keystore-path] <store-password>}"
KEY_ALIAS="${3:-mathmd}"
if [ -f "$KEYSTORE" ]; then echo "keystore already exists: $KEYSTORE"; exit 0; fi
keytool -genkeypair -v \
  -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$KS_PASS" -keypass "$KS_PASS" \
  -dname "CN=MathMD, OU=LckHot, O=LckHot, C=CN"
echo "keystore written: $KEYSTORE"
echo "next: base64 -w0 $KEYSTORE  ->  repo secret RELEASE_KEYSTORE_B64"
