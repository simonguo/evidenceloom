#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"
python3 scripts/check_versions.py

"$REPO_ROOT/scripts/ensure_sidecar_placeholder.sh"

cd "$REPO_ROOT/frontend"
npm run typecheck
npm run lint
npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
rm -rf .next out
NEXT_TELEMETRY_DISABLED=1 TAURI=1 npm run build

cd "$REPO_ROOT"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked

echo "Desktop technical-user build checks passed."
