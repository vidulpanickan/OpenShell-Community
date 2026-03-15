#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Local UI preview — no Docker. Builds the extension and serves preview/index.html
# so you can see UI changes without rebuilding the full image.
#
# Usage:
#   ./dev-preview.sh           # build once and serve (Ctrl+C to stop)
#   ./dev-preview.sh --watch   # rebuild on file changes
#
# Open http://localhost:5173 (or the port shown). The page auto-adds ?preview=1
# so the extension skips the pairing overlay and shows the UI immediately.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
PREVIEW_DIR="$SCRIPT_DIR/preview"
OUT_JS="$PREVIEW_DIR/nemoclaw-devx.js"
OUT_CSS="$PREVIEW_DIR/nemoclaw-devx.css"
PORT="${PORT:-5173}"
WATCH=""

for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
  esac
done

mkdir -p "$PREVIEW_DIR"

build() {
  (cd "$EXT_DIR" && npm install --production 2>/dev/null || true)
  # Bundle JS; CSS import is stubbed so we link styles separately below.
  npx --yes esbuild "$EXT_DIR/index.ts" \
    --bundle \
    --format=esm \
    --outfile="$OUT_JS" \
    --loader:.css=empty
  cp "$EXT_DIR/styles.css" "$OUT_CSS"
  echo "[dev-preview] Built $OUT_JS and $OUT_CSS"
}

build

if [[ -n "$WATCH" ]]; then
  echo "[dev-preview] Watching extension/*.ts — edit and refresh. For CSS changes, re-run without --watch or copy extension/styles.css to preview/nemoclaw-devx.css"
  npx --yes esbuild "$EXT_DIR/index.ts" \
    --bundle --format=esm --outfile="$OUT_JS" --loader:.css=empty \
    --watch &
  ESBUILD_PID=$!
  trap 'kill $ESBUILD_PID 2>/dev/null' EXIT
  sleep 1
fi

echo "[dev-preview] Serving at http://localhost:$PORT"
echo "[dev-preview] Open that URL (page auto-adds ?preview=1). Edit extension files and refresh to see UI changes."
if command -v python3 >/dev/null 2>&1; then
  (cd "$PREVIEW_DIR" && python3 -m http.server "$PORT")
elif command -v npx >/dev/null 2>&1; then
  (cd "$PREVIEW_DIR" && npx --yes serve -l "$PORT")
else
  echo "Install python3 or Node to run a local server, or open preview/index.html in a browser after running the build step manually."
  exit 1
fi
