#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
SITE="${SCRIPT_DIR:h}"
GENERATOR="$SCRIPT_DIR/generate_dynamic_watch_wall.py"

# Some environments set a local proxy (e.g. 127.0.0.1:7890) which can break
# upstream data fetches. Force direct connections for this automation run.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
export NO_PROXY="*"

python3 "$GENERATOR"

cd "$SITE"
git add -A
if git diff --cached --quiet; then
  echo "No watch wall changes to publish."
else
  git commit -m "Update dynamic A-share sector watch wall $(date +%F)"
  git push
fi
