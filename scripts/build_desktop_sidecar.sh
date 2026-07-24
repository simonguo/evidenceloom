#!/usr/bin/env bash
# Build a self-contained Evidence Loom desktop app with PyInstaller sidecar.
#
# Usage:
#   scripts/build_desktop_sidecar.sh [options]
#
# Options:
#   --target TRIPLE   Rust target triple (default: auto-detect via rustc)
#   --python PATH     Python executable to use (default: .venv/bin/python)
#   --mode   MODE     EVIDENCELOOM_RUNNER_MODE passed to tauri build: auto|sidecar (default: auto)
#   --tauri-config C  Extra Tauri config file path or inline JSON object
#   --skip-sidecar    Skip PyInstaller step (re-use existing sidecar binary)
#   --skip-tauri      Only build the sidecar, skip Tauri packaging
#
# Examples:
#   scripts/build_desktop_sidecar.sh
#   scripts/build_desktop_sidecar.sh --target aarch64-apple-darwin
#   scripts/build_desktop_sidecar.sh --skip-sidecar   # re-package Tauri after fixing hiddenimports
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET_TRIPLE=""
PYTHON=""
RUNNER_MODE="auto"
TAURI_CONFIG=""
SKIP_SIDECAR=0
SKIP_TAURI=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)   TARGET_TRIPLE="$2"; shift 2 ;;
    --python)   PYTHON="$2";        shift 2 ;;
    --mode)     RUNNER_MODE="$2";   shift 2 ;;
    --tauri-config) TAURI_CONFIG="$2"; shift 2 ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    --skip-tauri)   SKIP_TAURI=1;   shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve target triple
# ---------------------------------------------------------------------------
if [[ -z "$TARGET_TRIPLE" ]]; then
  if ! command -v rustc >/dev/null 2>&1; then
    echo "ERROR: rustc not found. Install Rust or pass --target explicitly." >&2
    exit 1
  fi
  TARGET_TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"
fi
echo "Target triple: $TARGET_TRIPLE"

# ---------------------------------------------------------------------------
# Resolve Python
# ---------------------------------------------------------------------------
if [[ -z "$PYTHON" ]]; then
  if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then
    PYTHON="$REPO_ROOT/.venv/Scripts/python.exe"
  else
    PYTHON="$REPO_ROOT/.venv/bin/python"
  fi
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "ERROR: Python not found at '$PYTHON'." >&2
  echo "Create a venv first:  python3 -m venv .venv && .venv/bin/pip install -e ." >&2
  exit 1
fi
echo "Python: $PYTHON"

# ---------------------------------------------------------------------------
# Step 1 – Build PyInstaller sidecar
# ---------------------------------------------------------------------------
if [[ "$SKIP_SIDECAR" -eq 0 ]]; then
  echo ""
  echo "==> Step 1: Building PyInstaller sidecar..."

  if ! "$PYTHON" -c "import PyInstaller" 2>/dev/null; then
    echo "PyInstaller not found – installing..."
    "$PYTHON" -m pip install pyinstaller
  fi

  PYTHON="$PYTHON" bash "$REPO_ROOT/scripts/build_tauri_sidecar.sh" "$TARGET_TRIPLE"
  echo "Sidecar built."
else
  echo "==> Step 1: Skipped (--skip-sidecar)."
fi

# Verify sidecar is a real binary (not placeholder)
SIDECAR_BIN="$REPO_ROOT/src-tauri/binaries/evidenceloom-runner-$TARGET_TRIPLE"
if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then
  SIDECAR_BIN="$SIDECAR_BIN.exe"
fi

if [[ ! -f "$SIDECAR_BIN" ]]; then
  echo "ERROR: Sidecar binary not found at $SIDECAR_BIN" >&2
  exit 1
fi
if grep -q "EVIDENCELOOM_SIDECAR_PLACEHOLDER" "$SIDECAR_BIN" 2>/dev/null; then
  echo "ERROR: $SIDECAR_BIN is still the placeholder. The PyInstaller build may have failed." >&2
  exit 1
fi
echo "Sidecar binary verified: $SIDECAR_BIN"

# A real identity makes PyInstaller sign both the launcher and every collected
# Mach-O binary with hardened runtime enabled. This is required before the
# one-file archive is created; Tauri cannot repair embedded signatures later.
if [[ "$TARGET_TRIPLE" == *"apple-darwin" && -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --verify --strict --verbose=2 "$SIDECAR_BIN"
  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    SIDECAR_TEAM_ID="$(
      codesign --display --verbose=4 "$SIDECAR_BIN" 2>&1 |
        awk -F= '/^TeamIdentifier=/{print $2; exit}'
    )"
    if [[ "$SIDECAR_TEAM_ID" != "$APPLE_TEAM_ID" ]]; then
      echo "ERROR: Sidecar Team ID '$SIDECAR_TEAM_ID' does not match APPLE_TEAM_ID." >&2
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 2 – Quick smoke-test the sidecar
# ---------------------------------------------------------------------------
if [[ "$SKIP_SIDECAR" -eq 0 ]]; then
  echo ""
  echo "==> Step 2: Smoke-testing sidecar..."
  set +e
  RESULT="$(printf '%s\n' '{"__command":"smoke_test"}' | "$SIDECAR_BIN" 2>&1)"
  SIDECAR_STATUS=$?
  set -e
  if echo "$RESULT" | grep -q '"type": "ready"' && [[ "$SIDECAR_STATUS" -eq 0 ]]; then
    echo "Sidecar smoke-test passed."
  else
    echo "ERROR: Sidecar returned unexpected output:"
    printf '%s\n' "$RESULT" | sed 's/^/  /'
    exit 1
  fi
else
  echo "==> Step 2: Skipped (--skip-sidecar)."
fi

# ---------------------------------------------------------------------------
# Step 3 – Build Tauri app
# ---------------------------------------------------------------------------
if [[ "$SKIP_TAURI" -eq 0 ]]; then
  echo ""
  echo "==> Step 3: Building Tauri app (EVIDENCELOOM_RUNNER_MODE=$RUNNER_MODE)..."
  cd "$REPO_ROOT/frontend"
  TAURI_ARGS=(--target "$TARGET_TRIPLE")
  if [[ -n "$TAURI_CONFIG" ]]; then
    TAURI_ARGS+=(--config "$TAURI_CONFIG")
  fi
  EVIDENCELOOM_RUNNER_MODE="$RUNNER_MODE" npm run tauri:build -- "${TAURI_ARGS[@]}"

  echo ""
  echo "==> Build complete. Artifacts:"
  find "$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE/release/bundle" \
    \( -name "*.app" -o -name "*.dmg" -o -name "*.exe" -o -name "*.msi" \) \
    -maxdepth 4 2>/dev/null | sed 's/^/    /'
else
  echo "==> Step 3: Skipped (--skip-tauri)."
fi
