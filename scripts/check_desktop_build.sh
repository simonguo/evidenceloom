#!/usr/bin/env bash
set -euo pipefail

if [[ ${EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY+x} ]]; then
  echo "desktop_proof_invalid: shipping frontend selector must be absent" >&2
  exit 1
fi

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
FRONTEND_EVIDENCE_PARENT="$REPO_ROOT/src-tauri/target/desktop-build-frontend-evidence-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
mkdir -m 700 -p "$FRONTEND_EVIDENCE_PARENT"
python3 "$REPO_ROOT/scripts/desktop_frontend_evidence.py" \
  --frontend "$REPO_ROOT/frontend" --evidence-parent "$FRONTEND_EVIDENCE_PARENT" \
  --receipt-output "$FRONTEND_EVIDENCE_PARENT/frontend-receipt.json"

cd "$REPO_ROOT"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked

echo "Desktop technical-user build checks passed."
