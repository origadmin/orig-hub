#!/usr/bin/env sh
# ============================================================
# orig-hub pollution gate  (AGENTS.md §6 / §7)
#
# Blocks, in the STAGED set:
#   1. root-level files outside the whitelist
#   2. AI/Agent tool directories (ZERO TOLERANCE)
#   3. temp files (*.tmp *.bak *.orig *~ *.swp *.log)
#   4. probe/scratch artifacts left in a working dir
#   5. batch/cmd helpers outside scripts/ (local convenience wrappers)
#   6. scripts loose at a cabin root (cabins hold source, not helpers)
#   7. scripts containing machine-absolute paths (non-portable)
#   8. non-UTF8/binary scripts (encoding unverifiable)
#
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

# Anything that is executed / interpreted rather than compiled.
is_script() {
  case "$1" in
    *.sh|*.py|*.mjs|*.cjs|*.js|*.ps1|*.bat|*.cmd) return 0 ;;
    *) return 1 ;;
  esac
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

  # (5) batch/cmd helpers are Windows-local convenience wrappers -> only scripts/ may hold them
  case "$f" in
    *.bat|*.cmd)
      case "$f" in
        scripts/*) : ;;
        *) bad "batch/cmd helper outside scripts/ (relocate or keep local): $f" ;;
      esac ;;
  esac

  # (6) cabins hold SOURCE; a bare script at a cabin root is a stray helper.
  #     Deliverable verification belongs in <cabin>/verify/ or the repo-level scripts/.
  case "$f" in
    download-engine/*|tauri-shell/*)
      case "$f" in
        */*/*) : ;;   # deeper than the cabin root -> allowed
        *)
          if is_script "$f"; then
            bad "script loose at cabin root (move to <cabin>/verify/ or scripts/): $f"
          fi ;;
      esac ;;
  esac

  # (7)/(8) script hygiene: portable paths + verifiable encoding
  # NOTE: the path regex is anchored so it cannot match THIS gate's own source
  # (a naive pattern would contain its own trigger and self-block every commit),
  # and the leading-boundary rule keeps URLs like "http://" from matching.
  if is_script "$f" && [ -f "$f" ]; then
    if grep -qE '(^|[^A-Za-z])[A-Za-z]:[\\/]|/(c|C)/Users/' "$f" 2>/dev/null; then
      bad "machine-absolute path in script (use relative or \$(dirname \"\$0\")): $f"
    fi
    if od -An -c "$f" 2>/dev/null | grep -q '\\0'; then
      bad "binary/non-UTF8 script (encoding not verifiable, convert to UTF-8/ASCII): $f"
    fi
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Commit blocked by pollution gate (AGENTS.md §7)."
  echo "Fix the root cause:"
  echo "  - move scratch to .scratch/ or system temp"
  echo "  - move docs into docs/  (never the repo root)"
  echo "  - move helper scripts to <cabin>/verify/ or scripts/"
  echo "  - delete temp files / replace machine paths with relative ones"
  echo "Do NOT bypass with --no-verify."
  exit 1
fi

exit 0
