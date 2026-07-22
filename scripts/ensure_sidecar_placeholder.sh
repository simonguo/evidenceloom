#!/usr/bin/env bash
set -euo pipefail

TARGET_TRIPLE="${1:-}"
if [[ -z "$TARGET_TRIPLE" ]]; then
  if command -v rustc >/dev/null 2>&1; then
    TARGET_TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"
  else
    echo "target triple is required when rustc is unavailable" >&2
    exit 1
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/src-tauri/binaries/evidenceloom-runner-$TARGET_TRIPLE"
if [[ "$TARGET_TRIPLE" == *"windows"* || "$TARGET_TRIPLE" == *"msvc"* ]]; then
  DEST="$DEST.exe"
fi

if [[ -f "$DEST" ]]; then
  echo "Sidecar already exists: $DEST"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
cat > "$DEST" <<'SH'
#!/usr/bin/env sh
# EVIDENCELOOM_SIDECAR_PLACEHOLDER
echo '{"type":"error","error":"Evidence Loom sidecar placeholder was executed. Build the real PyInstaller sidecar with scripts/build_tauri_sidecar.sh and rebuild the app, or use EVIDENCELOOM_RUNNER_MODE=python."}'
exit 127
SH
chmod +x "$DEST" || true

echo "Placeholder sidecar written to: $DEST"
