#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
SITE="${SCRIPT_DIR:h}"
GENERATOR="$SCRIPT_DIR/generate_dynamic_watch_wall.py"

python3 "$GENERATOR"

cd "$SITE"
git add -A
if git diff --cached --quiet; then
  echo "No watch wall changes to publish."
else
  git commit -m "Update dynamic A-share sector watch wall $(date +%F)"
  git push
fi
