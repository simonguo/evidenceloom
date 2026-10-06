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

if [[ ${EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY+x} ]]; then
  echo "desktop_proof_invalid: shipping frontend selector must be absent" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET_TRIPLE=""
PYTHON=""
RUNNER_MODE="auto"
TAURI_CONFIG=""
SKIP_SIDECAR=0
SKIP_TAURI=0
BOUNDARY="$REPO_ROOT/scripts/check_desktop_acceptance_boundary.py"

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
BASE_COMMIT="${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
SIDECAR_BIN="$REPO_ROOT/src-tauri/binaries/evidenceloom-runner-$TARGET_TRIPLE"
if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then
  SIDECAR_BIN="$SIDECAR_BIN.exe"
fi
SIDECAR_PROOF="$SIDECAR_BIN.shipping-proof.json"

# ---------------------------------------------------------------------------
# Step 1 – Build PyInstaller sidecar
# ---------------------------------------------------------------------------
if [[ "$SKIP_SIDECAR" -eq 0 ]]; then
  "$PYTHON" "$REPO_ROOT/scripts/sidecar_architecture.py" interpreter "$TARGET_TRIPLE"
  echo ""
  echo "==> Step 1: Building PyInstaller sidecar..."

  if ! "$PYTHON" -c "import PyInstaller" 2>/dev/null; then
    echo "PyInstaller not found – installing..."
    "$PYTHON" -m pip install pyinstaller
  fi

  "$PYTHON" "$BOUNDARY" build-shipping-sidecar --repo "$REPO_ROOT" \
    --target "$TARGET_TRIPLE" --python "$PYTHON" --binary "$SIDECAR_BIN" \
    --proof "$SIDECAR_PROOF" --base-commit "$BASE_COMMIT"
  echo "Sidecar built."
else
  "$PYTHON" "$BOUNDARY" sidecar-check --repo "$REPO_ROOT" \
    --target "$TARGET_TRIPLE" --binary "$SIDECAR_BIN" --proof "$SIDECAR_PROOF"
  echo "==> Step 1: Skipped (--skip-sidecar)."
fi

# Verify sidecar is a real binary (not placeholder)
if [[ ! -f "$SIDECAR_BIN" ]]; then
  echo "ERROR: Sidecar binary not found at $SIDECAR_BIN" >&2
  exit 1
fi
"$PYTHON" "$REPO_ROOT/scripts/sidecar_architecture.py" binary "$TARGET_TRIPLE" "$SIDECAR_BIN"
echo "Sidecar OS and architecture verified: $SIDECAR_BIN"

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
# Step 2 – Check bootstrap and actual research imports, including reused binaries
# ---------------------------------------------------------------------------
echo ""
echo "==> Step 2: Checking sidecar bootstrap and research imports..."
# Legacy-safe: older sidecars recognize smoke_test and cannot enter an analysis;
# their plain ready response is insufficient and requires rebuilding.
# Both sequential probes share one bounded 90-second deadline.
if [[ "$SKIP_SIDECAR" -eq 1 ]]; then
  "$PYTHON" "$REPO_ROOT/scripts/sidecar_probe.py" all "$SIDECAR_BIN"
fi

# ---------------------------------------------------------------------------
# Step 3 – Build Tauri app
# ---------------------------------------------------------------------------
if [[ "$SKIP_TAURI" -eq 0 ]]; then
  echo ""
  echo "==> Step 3: Building Tauri app (EVIDENCELOOM_RUNNER_MODE=$RUNNER_MODE)..."
  PROOF_DIR="$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE/release/desktop-shipping-proofs/$($PYTHON -c 'import uuid; print(uuid.uuid4().hex)')"
  mkdir -m 700 -p "$PROOF_DIR"
  # The frontend is built exactly once. The subsequent CLI hook is removed from
  # the effective overlay so Next's per-build identifier cannot invalidate proof.
  cd "$REPO_ROOT/frontend"
  "$PYTHON" "$REPO_ROOT/scripts/desktop_frontend_evidence.py" \
    --frontend "$REPO_ROOT/frontend" --evidence-parent "$PROOF_DIR" \
    --receipt-output "$PROOF_DIR/frontend-receipt.json"
  FRONTEND_PROOF="$($PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1]))["frontendProof"])' "$PROOF_DIR/frontend-receipt.json")"
  "$PYTHON" - "$TAURI_CONFIG" "$PROOF_DIR/tauri-overlay.json" <<'PY'
import json
from pathlib import Path
import sys
value = {}
if sys.argv[1]:
    value = json.loads(sys.argv[1]) if sys.argv[1].lstrip().startswith('{') else json.loads(Path(sys.argv[1]).read_text())
value.setdefault('build', {})['beforeBuildCommand'] = None
Path(sys.argv[2]).write_text(json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n')
PY
  cd "$REPO_ROOT"
  TAURI_CONFIG="$(cat "$PROOF_DIR/tauri-overlay.json")" \
    cargo check --manifest-path src-tauri/Cargo.toml --bin evidenceloom-desktop \
    --target "$TARGET_TRIPLE" --release --locked --message-format=json > "$PROOF_DIR/metadata.jsonl"
  TYPED_CONFIG="$($PYTHON - "$PROOF_DIR/metadata.jsonl" <<'PY'
import json
from pathlib import Path
import sys
messages = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.startswith('{')]
directories = [item['out_dir'] for item in messages if item.get('reason') == 'build-script-executed' and 'evidenceloom-desktop' in item.get('package_id', '')]
if len(directories) != 1:
    raise SystemExit('desktop_proof_invalid')
print(Path(directories[0]) / 'desktop-effective-config.json')
PY
  )"
  "$PYTHON" "$BOUNDARY" prepare-shipping --repo "$REPO_ROOT" --target "$TARGET_TRIPLE" \
    --binary "$SIDECAR_BIN" --proof "$SIDECAR_PROOF" --base-commit "$BASE_COMMIT" \
    --directory "$PROOF_DIR/app-stage" --overlay "$PROOF_DIR/tauri-overlay.json" --typed-config "$TYPED_CONFIG" \
    --frontend-proof "$FRONTEND_PROOF"
  cd "$REPO_ROOT/frontend"
  EVIDENCELOOM_RUNNER_MODE="$RUNNER_MODE" \
    EVIDENCELOOM_DESKTOP_BUILD_STAMP="$PROOF_DIR/app-stage/desktop-build-stamp.json" \
    npm run tauri:build -- --target "$TARGET_TRIPLE" --config "$PROOF_DIR/tauri-overlay.json"
  APP_EXECUTABLE="$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE/release/evidenceloom-desktop"
  if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then APP_EXECUTABLE="$APP_EXECUTABLE.exe"; fi
  SEAL_ARGS=(--directory "$PROOF_DIR/app-stage" --executable "$APP_EXECUTABLE")
  if [[ "$TARGET_TRIPLE" == *"apple-darwin"* ]]; then
    APP_BUNDLE="$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE/release/bundle/macos/Evidence Loom.app"
    SEAL_ARGS=(--directory "$PROOF_DIR/app-stage" --executable "$APP_BUNDLE/Contents/MacOS/evidenceloom-desktop" --bundle "$APP_BUNDLE")
  fi
  "$PYTHON" "$BOUNDARY" seal-build "${SEAL_ARGS[@]}"
  # The current job consumes this path; proof files never enter public assets.
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf 'EVIDENCELOOM_SHIPPING_BUILD_PROOF=%s\n' "$PROOF_DIR/app-stage/build-proof.json" >> "$GITHUB_ENV"
  fi

  echo ""
  echo "==> Build complete. Artifacts:"
  find "$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE/release/bundle" \
    \( -name "*.app" -o -name "*.dmg" -o -name "*.exe" -o -name "*.msi" \) \
    -maxdepth 4 2>/dev/null | sed 's/^/    /'
else
  echo "==> Step 3: Skipped (--skip-tauri)."
fi
