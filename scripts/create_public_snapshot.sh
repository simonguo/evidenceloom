#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: GITLEAKS_BIN=/path/to/gitleaks $0 /absolute/path/to/new-snapshot" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINATION="$1"
GITLEAKS="${GITLEAKS_BIN:-$(command -v gitleaks || true)}"

if [[ "$DESTINATION" != /* ]]; then
  echo "ERROR: destination must be an absolute path." >&2
  exit 1
fi
if [[ -e "$DESTINATION" ]]; then
  echo "ERROR: destination already exists; refusing to overwrite it: $DESTINATION" >&2
  exit 1
fi
if [[ -z "$GITLEAKS" || ! -x "$GITLEAKS" ]]; then
  echo "ERROR: a verified gitleaks binary is required via GITLEAKS_BIN or PATH." >&2
  exit 1
fi
if [[ "$(git -C "$REPO_ROOT" branch --show-current)" != "main" ]]; then
  echo "ERROR: create the public snapshot only from the audited private main checkout." >&2
  exit 1
fi

mkdir -p "$DESTINATION"
cd "$REPO_ROOT"
git ls-files --cached --others --exclude-standard | while IFS= read -r file; do
  if [[ -f "$file" || -L "$file" ]]; then
    printf '%s\n' "$file"
  fi
done | tar -cf - -T - | tar -xf - -C "$DESTINATION"

if [[ -e "$DESTINATION/.git" || -e "$DESTINATION/.env" ]]; then
  echo "ERROR: snapshot contains private Git metadata or a local environment file." >&2
  exit 1
fi
if find "$DESTINATION/src-tauri/binaries" -type f ! -name .gitkeep -print -quit | grep -q .; then
  echo "ERROR: snapshot contains a generated sidecar." >&2
  exit 1
fi
if find "$DESTINATION" -type f -size +50M -print -quit | grep -q .; then
  echo "ERROR: snapshot contains a file larger than 50 MB." >&2
  exit 1
fi

"$GITLEAKS" dir "$DESTINATION" --no-banner --no-color --redact --max-target-megabytes 50

git -C "$DESTINATION" init --initial-branch=main
git -C "$DESTINATION" config user.name "Simon Guo"
git -C "$DESTINATION" config user.email "simonguo@users.noreply.github.com"
git -C "$DESTINATION" add --all
git -C "$DESTINATION" commit --signoff --message "chore: publish Evidence Loom v0.1.0-beta.3"

test "$(git -C "$DESTINATION" rev-list --count HEAD)" = "1"
test -z "$(git -C "$DESTINATION" status --porcelain)"
echo "Audited one-commit public snapshot created at: $DESTINATION"
