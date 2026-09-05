#!/bin/bash
# Build the preview WebView bundle from TypeScript sources and install it
# into the Android assets. Run from repo root: scripts/build-preview.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TOOLS=tools
ESBUILD="$TOOLS/node_modules/.bin/esbuild"
OUT="app/src/main/assets/preview/bundle.js"

[ -x "$ESBUILD" ] || { echo "esbuild missing; run: (cd tools && npm install)"; exit 1; }

"$ESBUILD" "$TOOLS/preview-src/src/host.ts" --bundle --format=iife --outfile="$OUT"
# keep tsc honest (type check only, no emit)
"$TOOLS/node_modules/.bin/tsc" -p "$TOOLS/preview-src/tsconfig.json"
echo "preview bundle installed: $OUT"
