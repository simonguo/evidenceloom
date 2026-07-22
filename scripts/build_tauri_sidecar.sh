#!/usr/bin/env bash
set -euo pipefail

# Build the Evidence Loom PyInstaller sidecar for the current host target.
# Usage:
#   scripts/build_tauri_sidecar.sh <target-triple>
# Example:
#   scripts/build_tauri_sidecar.sh aarch64-apple-darwin
#   scripts/build_tauri_sidecar.sh x86_64-pc-windows-msvc
#
# Notes:
# - Build each target on its native OS/arch unless you have a proven cross-build setup.
# - Install PyInstaller in the Python environment first: python -m pip install pyinstaller
# - The Rust bridge supports EVIDENCELOOM_RUNNER_MODE=python|auto|sidecar.
# - Use auto/sidecar after validating the generated binary can read stdin and emit JSONL events.

TARGET_TRIPLE="${1:-}"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "target triple is required" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${TMPDIR:-/tmp}/evidenceloom-runner-dist"
WORK_DIR="${TMPDIR:-/tmp}/evidenceloom-runner-build"

rm -rf "$DIST_DIR" "$WORK_DIR"
cd "$REPO_ROOT"
"${PYTHON:-python}" -m PyInstaller frontend/server/evidenceloom-runner.spec --distpath "$DIST_DIR" --workpath "$WORK_DIR" --noconfirm

SOURCE_BIN="$DIST_DIR/evidenceloom-runner"
DEST_BIN="$REPO_ROOT/src-tauri/binaries/evidenceloom-runner-$TARGET_TRIPLE"
if [[ "$TARGET_TRIPLE" == *"windows"* || "$TARGET_TRIPLE" == *"msvc"* ]]; then
  SOURCE_BIN="$DIST_DIR/evidenceloom-runner.exe"
  DEST_BIN="$DEST_BIN.exe"
fi

cp "$SOURCE_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN" || true

echo "Sidecar written to: $DEST_BIN"
echo "Next: EVIDENCELOOM_RUNNER_MODE=auto cd frontend && npm run tauri:build"
