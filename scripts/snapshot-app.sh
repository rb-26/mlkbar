#!/usr/bin/env bash
set -euo pipefail

# Usage: snapshot-app.sh [mode]
#   mode=daily (default): skipped if app files are unchanged since the last snapshot.
#   any other mode (e.g. prechange): always taken. Set FORCE=1 to force a daily one.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$APP_DIR/snapshots}"
KEEP_COUNT="${KEEP_COUNT:-30}"
MODE="${1:-daily}"
FORCE="${FORCE:-0}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="littletrack-app-${MODE}-${TS}.tar.gz"
ARCHIVE_PATH="$SNAPSHOT_DIR/$ARCHIVE_NAME"
META_PATH="$SNAPSHOT_DIR/${ARCHIVE_NAME%.tar.gz}.meta.txt"

EXCLUDES=(
  --exclude='./data'
  --exclude='./backups'
  --exclude='./snapshots'
  --exclude='./__pycache__'
  --exclude='*.zip'
  --exclude='*.pyc'
  --exclude='._*'
  --exclude='.smbdelete*'
  --exclude='.DS_Store'
)

mkdir -p "$SNAPSHOT_DIR"

# Content hash of the files that would be archived (path + contents).
CONTENT_HASH="$(
  cd "$APP_DIR" && find . \
    \( -path ./data -o -path ./backups -o -path ./snapshots -o -path ./__pycache__ \) -prune -o \
    -type f ! -name '*.zip' ! -name '*.pyc' ! -name '._*' ! -name '.smbdelete*' ! -name '.DS_Store' -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
)"

if [ "$MODE" = "daily" ] && [ "$FORCE" != "1" ]; then
  LAST_META="$(ls -1t "$SNAPSHOT_DIR"/littletrack-app-*.meta.txt 2>/dev/null | head -n1 || true)"
  if [ -n "$LAST_META" ] && grep -qx "content_hash=$CONTENT_HASH" "$LAST_META"; then
    echo "No app changes since $(basename "$LAST_META"); skipping snapshot."
    exit 0
  fi
fi

tar -czf "$ARCHIVE_PATH" "${EXCLUDES[@]}" -C "$APP_DIR" .

{
  echo "mode=$MODE"
  echo "timestamp=$TS"
  echo "archive=$(basename "$ARCHIVE_PATH")"
  echo "content_hash=$CONTENT_HASH"
  if command -v git >/dev/null 2>&1 && git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "git_head=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    echo "git_status<<EOF"
    # Scope status to this app only, not the whole parent repo.
    git -C "$APP_DIR" status --short -- . || true
    echo "EOF"
  fi
} > "$META_PATH"

ls -1t "$SNAPSHOT_DIR"/littletrack-app-*.tar.gz 2>/dev/null | awk -v keep="$KEEP_COUNT" 'NR>keep' | xargs -r rm -f
ls -1t "$SNAPSHOT_DIR"/littletrack-app-*.meta.txt 2>/dev/null | awk -v keep="$KEEP_COUNT" 'NR>keep' | xargs -r rm -f

echo "$ARCHIVE_PATH"
