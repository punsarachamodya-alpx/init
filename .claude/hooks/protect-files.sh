#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|MultiEdit): block edits to protected paths.
# Exit 2 blocks the tool call and feeds stderr back to Claude.
set -u
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')
[ -z "$file" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file#"$root"/}"

block() {
  echo "Blocked: $rel - $1" >&2
  exit 2
}

case "$rel" in
  .env|.env.*|*/.env|*/.env.*) block "environment files are edited by hand by the owner only." ;;
  .git|.git/*|*/.git/*) block "do not touch .git internals." ;;
  pnpm-lock.yaml|package-lock.json|yarn.lock|*/pnpm-lock.yaml|*/package-lock.json|*/yarn.lock)
    block "lockfiles change only through the package manager." ;;
  fixtures/labels.json) block "labels.json is ground truth for scoring; never edit it." ;;
  fixtures/real/*|*/fixtures/real/*) block "real data must never be in the repo." ;;
esac

# Existing migrations are immutable; new migration files are allowed.
case "$rel" in
  */migrations/*|migrations/*)
    if [ -e "$file" ]; then
      block "existing migrations are immutable. Add a new migration instead."
    fi
    ;;
esac

exit 0
