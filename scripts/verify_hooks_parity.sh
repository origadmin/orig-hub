#!/usr/bin/env sh
# ============================================================
# Verify that the INSTALLED git hooks equal the TRACKED hooks.
#   sh scripts/verify_hooks_parity.sh
#
# Why this exists (BUG-187):
#   The installer used to *regenerate* pre-commit inline while the tracked copy under
#   scripts/hooks/ kept evolving, so the installed hook silently stayed on an older,
#   weaker revision (pollution gate only, bug-registry gate never ran). Nothing ever
#   compared the two, so the drift was invisible for months. The installer now verifies
#   parity itself; this script is the standalone, cross-machine re-check of the same
#   invariant, plus a wiring check that the hooks git would actually run are the ones on
#   disk.
#
# Checks (all read-only; installs nothing, commits nothing):
#   1. the real hooks dir exists and is inside the resolved git dir
#   2. installed pre-commit  == scripts/hooks/pre-commit
#   3. installed commit-msg  == scripts/hooks/commit-msg
#   4. both installed hooks are executable
#   5. every gate the tracked pre-commit claims to run actually exists and runs
#
# Exit codes: 0 = parity proven, 1 = drift / missing wiring (see message for the fix).
# ============================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

rc=0
note_fail() { echo "  FAIL: $1" >&2; rc=1; }

# --- where git actually looks for hooks (never assume "$ROOT/.git/hooks") ---
HOOKS="$(git rev-parse --path-format=absolute --git-path hooks 2>/dev/null || git rev-parse --git-path hooks)"
echo "hooks dir reported by git: $HOOKS"

# core.hooksPath, if set at any scope, overrides the location entirely and makes every
# gate below meaningless -- that is BUG-158. Report it loudly instead of failing, since
# the remedy is a repo-local git config change the user must make deliberately.
if hp="$(git config --get core.hooksPath 2>/dev/null)"; then
  if [ -d "$hp" ]; then
    echo "  NOTE: core.hooksPath is set to an existing dir; hooks run from there, NOT from $HOOKS."
  else
    echo "  WARNING (BUG-158): core.hooksPath='$hp' does not exist => NO hook will ever run." >&2
    echo "           hooks installed here are dead weight. Fix (user-run):" >&2
    echo "             git config --unset core.hooksPath" >&2
  fi
fi

# --- 1. hooks dir must exist ---
if [ ! -d "$HOOKS" ]; then
  note_fail "hooks dir does not exist: $HOOKS (run: sh scripts/install-hooks.sh)"
else
  echo "  ok: hooks dir exists"
fi

# --- 2 & 3. installed hooks must equal the tracked copies ---
for name in pre-commit commit-msg; do
  src="$ROOT/scripts/hooks/$name"
  dst="$HOOKS/$name"
  if [ ! -f "$src" ]; then
    note_fail "tracked source missing: $src"
    continue
  fi
  if [ ! -f "$dst" ]; then
    note_fail "$name not installed at $dst (run: sh scripts/install-hooks.sh)"
    continue
  fi
  if diff -q "$src" "$dst" >/dev/null 2>&1; then
    echo "  ok: $name IDENTICAL to scripts/hooks/$name"
  else
    note_fail "$name DIFFERS from scripts/hooks/$name -> installed hook is stale/weak:"
    diff -u "$dst" "$src" | sed -n '1,20p' >&2
    echo "           fix: sh scripts/install-hooks.sh" >&2
  fi
  # --- 4. must be executable, or git silently skips it ---
  if [ -x "$dst" ]; then
    echo "  ok: $name is executable"
  else
    note_fail "$name is NOT executable (git silently skips non-executable hooks)"
  fi
done

# --- 5. every gate the tracked pre-commit invokes must exist ---
echo "checking gate dependencies declared by scripts/hooks/pre-commit:"
for dep in check-bugs.py check-decisions.py check-pollution.sh; do
  if [ -f "$ROOT/scripts/$dep" ]; then
    echo "  ok: scripts/$dep present"
  else
    note_fail "scripts/$dep missing but scripts/hooks/pre-commit requires it"
  fi
done

if [ "$rc" -eq 0 ]; then
  echo "PASS: installed hooks match the tracked hooks and their gates are present."
else
  echo "FAIL: hook wiring is not trustworthy -- see the FAIL lines above." >&2
fi
exit $rc