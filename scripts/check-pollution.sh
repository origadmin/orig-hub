#!/usr/bin/env sh
# ============================================================
# orig-hub pollution gate  (AGENTS.md §6 / §7)
# Blocks, in the STAGED set:
#   1. root-level files outside the whitelist
#   2. AI/Agent tool directories (ZERO TOLERANCE)
#   3. temp files (*.tmp *.bak *.orig *~ *.swp *.log)
#   4. probe/scratch artifacts left in working dirs
# Fix the ROOT CAUSE (relocate / delete / add .gitignore).
# NEVER bypass with --no-verify.
# ============================================================
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0

FAIL=0
bad() { printf '\033[31m[POLLUTION]\033[0m %s\n' "$1"; FAIL=1; }

# Whitelisted files allowed at repository root (must stay in sync with AGENTS.md §6.1).
ROOT_WHITELIST=".gitignore AGENTS.md README.md download-engine.toml"

is_root_whitelisted() {
  for w in $ROOT_WHITELIST; do [ "$1" = "$w" ] && return 0; done
  return 1
}

STAGED=$(git diff --cached --name-only --diff-filter=ACMR)

for f in $STAGED; do
  # (1) root-level file outside whitelist
  case "$f" in
    */*) : ;;
    *) is_root_whitelisted "$f" || bad "root-level file not in whitelist: $f" ;;
  esac

  # (2) AI/Agent tool artifacts
  case "$f" in
    .trae/*|.claude/*|.cursor/*|.cursorrules|.cursorignore|.coder/*|.augment/*|.sourcegraph/*|.continue/*|.aider*|.kiro/*|.cody/*|.codex/*|.codeium/*|.windsurf*|.agents/*|.agent/*|CLAUDE.md|skills-lock.json)
      bad "AI tool artifact must never be committed: $f" ;;
  esac

  # (3) temp files
  case "$f" in
    *.tmp|*.bak|*.orig|*~|*.swp|*.swo|*.log)
      bad "temp file must never be committed: $f" ;;
  esac

  # (4) probe/scratch artifacts left in a working dir
  case "$f" in
    */probe_*|*/tmp_*|*/temp_*|*/scratch_*|*/debug_*|*/.scratch/*|*/_probe/*)
      bad "scratch/probe artifact in working dir: $f" ;;
  esac
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Commit blocked by pollution gate (AGENTS.md §7)."
  echo "Fix the root cause:"
  echo "  - move scratch to .scratch/ or system temp"
  echo "  - move docs into docs/  (never the repo root)"
  echo "  - delete temp files / add a .gitignore rule"
  echo "Do NOT bypass with --no-verify."
  exit 1
fi

exit 0
