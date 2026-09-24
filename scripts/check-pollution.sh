#!/usr/bin/env sh
# ============================================================
# orig-hub pollution gate  (AGENTS.md §6 / §7)
#
# Blocks, in the STAGED set:
#   1. root-level files outside the whitelist
#   2. AI/Agent tool directories (ZERO TOLERANCE)
#   3. temp files (*.tmp *.bak *.orig *~ *.swp *.log)
#      + dot-prefixed scratch/probe dumps at repo root (".tmp-find2.txt",
#        ".zz1.txt", ".probe-x") -- the suffix-only list missed those entirely.
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

# --- Repo root localisation -------------------------------------------------
# This gate lives in projects/orig-hub/ but the authoritative repo is the OUTER
# monorepo. `git rev-parse --show-toplevel` therefore answers the OUTER root
# whenever the caller sits in the outer tree (local pre-commit, or any manual run
# from the monorepo), and `--show-prefix` is then EMPTY -- there is no prefix to
# peel, and every staged name carries "projects/orig-hub/", i.e. a slash. The
# root whitelist used to skip on exactly that slash and never examined a single
# orig-hub root file. So the project root is derived from where THIS script is
# installed instead: the directory the gate sits in is the directory to judge
# against, no matter who invoked us.
SH=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
ROOT=${SH%/scripts}
[ "$ROOT" != "$SH" ] || ROOT=http_placeholder_never_matches
cd "$ROOT" || exit 0
GITROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
case "$GITROOT/" in
  "$(pwd)/"*) PREFIX="." ;;
  *) PREFIX=$(git rev-parse --show-prefix 2>/dev/null) ;;
esac

# Staged entries live in the repo Git knows about (ROOT, or a parent when we sit
# inside the outer monorepo), not necessarily in a repo rooted at ROOT. Listing
# from ROOT and peeling PREFIX keeps both invocation styles on the same terms.
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)

FAIL=0
bad() { printf '\033[31m[POLLUTION]\033[0m %s\n' "$1"; FAIL=1; }

# Whitelisted files allowed at repository root (must stay in sync with AGENTS.md §6.1).
ROOT_WHITELIST=".gitignore AGENTS.md README.md download-engine.toml"

is_root_whitelisted() {
  for w in $ROOT_WHITELIST; do [ "$1" = "$w" ] && return 0; done
  return 1
}

# Local paths from a staged list that may carry a project/monorepo prefix:
# both the prefixed and the local form of every entry are examined.
local_paths() {
  path="$1"
  printf '%s\n' "$path"
  if [ "$PREFIX" != "." ] && [ -n "$PREFIX" ]; then
    case "$path" in
      "$PREFIX"*) printf '%s\n' "${path#"$PREFIX"}" ;;
    esac
  fi
}

# Scratch/probe dumps normally start with a "." so they need no .gitignore
# entry -- which is exactly why the suffix-only temp list never saw them.
# Keeping this to dot-prefixed names at the repo root preserves legitimate
# uses of the ".tmp" *extension* (the download engine writes `<name>.tmp`
# inside data dirs, never a dotfile at the root).
is_dot_scratch() {
  case "$1" in
    .tmp-*|.tmp_*|.tmp.*|.scratch*|.probe*|.dbg-*|.dbg_*|.dbg.*|.zz*) return 0 ;;
    *) return 1 ;;
  esac
}

# Anything that is executed / interpreted rather than compiled.
is_script() {
  case "$1" in
    *.sh|*.py|*.mjs|*.cjs|*.js|*.ps1|*.bat|*.cmd) return 0 ;;
    *) return 1 ;;
  esac
}

for f in $STAGED; do
  # Working-tree copy for the prefix-peeled form, so the hygiene rules below can
  # still read the file when the staged name carries a monorepo prefix.
  ft=""
  if [ "$PREFIX" = "." ] || [ -z "$PREFIX" ]; then
    [ -f "$f" ] && ft="$f"
  else
    case "$f" in
      "$PREFIX"*) t="${f#"$PREFIX"}"; [ -f "$t" ] && ft="$t" ;;
      *) [ -f "$f" ] && ft="$f" ;;
    esac
  fi

  for lf in $(local_paths "$f"); do
    # (1) root-level file outside whitelist -- judged against THIS project's root
    case "$lf" in
      */*) : ;;
      *) is_root_whitelisted "$lf" || bad "root-level file not in whitelist: $lf" ;;
    esac

    # (3) temp files -- suffix list plus dot-prefixed scratch/probe dumps
    case "$lf" in
      *.tmp|*.bak|*.orig|*~|*.swp|*.swo|*.log)
        bad "temp file must never be committed: $lf" ;;
    esac
    case "$lf" in
      */*) : ;;
      *) is_dot_scratch "$lf" && bad "dot-prefixed scratch/probe file at repo root: $lf" ;;
    esac

    # (4) probe/scratch artifacts left in a working dir
    case "$lf" in
      */probe_*|*/tmp_*|*/temp_*|*/scratch_*|*/debug_*|*/.scratch/*|*/_probe/*)
        bad "scratch/probe artifact in working dir: $lf" ;;
    esac

    # (5) batch/cmd helpers are Windows-local convenience wrappers -> only scripts/ may hold them
    case "$lf" in
      *.bat|*.cmd)
        case "$lf" in
          scripts/*) : ;;
          *) bad "batch/cmd helper outside scripts/ (relocate or keep local): $lf" ;;
        esac ;;
    esac

    # (6) cabins hold SOURCE; a bare script at a cabin root is a stray helper.
    #     Deliverable verification belongs in <cabin>/verify/ or the repo-level scripts/.
    case "$lf" in
      download-engine/*|tauri-shell/*)
        case "$lf" in
          */*/*) : ;;   # deeper than the cabin root -> allowed
          *)
            if is_script "$lf"; then
              bad "script loose at cabin root (move to <cabin>/verify/ or scripts/): $lf"
            fi ;;
        esac ;;
    esac
  done

  # (2) AI/Agent tool artifacts (prefix-insensitive: matches at any depth)
  case "$f" in
    .trae/*|.claude/*|.cursor/*|.cursorrules|.cursorignore|.coder/*|.augment/*|.sourcegraph/*|.continue/*|.aider*|.kiro/*|.cody/*|.codex/*|.codeium/*|.windsurf*|.agents/*|.agent/*|CLAUDE.md|skills-lock.json)
      bad "AI tool artifact must never be committed: $f" ;;
  esac

  # (7)/(8) script hygiene: portable paths + verifiable encoding
  # NOTE: the path regex is anchored so it cannot match THIS gate's own source
  # (a naive pattern would contain its own trigger and self-block every commit),
  # and the leading-boundary rule keeps URLs like "http://" from matching.
  if is_script "$f" && [ -n "$ft" ]; then
    if grep -qE '(^|[^A-Za-z])[A-Za-z]:[\\/]|/(c|C)/Users/' "$ft" 2>/dev/null; then
      bad "machine-absolute path in script (use relative or \$(dirname \"\$0\")): $lf"
    fi
    if od -An -c "$ft" 2>/dev/null | grep -q '\\0'; then
      bad "binary/non-UTF8 script (encoding not verifiable, convert to UTF-8/ASCII): $lf"
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
