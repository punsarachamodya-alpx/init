#!/usr/bin/env bash
# Stop hook: do not let Claude finish while typecheck or test fail.
# Only runs scripts that exist in package.json, so it is quiet before scaffolding.
# Guarded against loops via stop_hook_active.
set -u
input=$(cat)
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
[ -f package.json ] || exit 0
command -v pnpm >/dev/null 2>&1 || exit 0

has_script() { jq -e --arg s "$1" '.scripts[$s] // empty' package.json >/dev/null 2>&1; }

fail=0
out=""
for s in typecheck test; do
  if has_script "$s"; then
    res=$(timeout 300 pnpm -s "$s" 2>&1) || { fail=1; out="$out
--- pnpm $s failed ---
$(printf '%s' "$res" | tail -n 40)"; }
  fi
done

if [ "$fail" -eq 1 ]; then
  echo "Do not finish yet: typecheck/test are failing. Fix them or explain why they cannot pass.$out" >&2
  exit 2
fi
exit 0
