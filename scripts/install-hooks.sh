#!/usr/bin/env sh
# ============================================================
# Install repo git hooks (hooks are NOT version-controlled).
#   sh scripts/install-hooks.sh
#
# Installs the hooks from their single tracked source under scripts/hooks/:
#   pre-commit -> scripts/hooks/pre-commit  (pollution gate only -- commits stay fast, AGENTS.md §7)
#   commit-msg -> scripts/hooks/commit-msg  (English-only commit messages, AGENTS.md §2)
#   pre-push   -> scripts/hooks/pre-push    (bug-registry + decision gates at delivery, AGENTS.md §7)
#
# Two defects fixed here (BUG-187). Both are "the installer and the tracked copy
# drifted apart", which is the same failure the tracked pre-commit's own header warns about:
#
#  1. pre-commit used to be *regenerated inline* by this script while the tracked copy
#     scripts/hooks/pre-commit kept evolving. The installed hook therefore stayed at an
#     older, weaker revision: it ran only the pollution gate and never the bug-registry
#     gate, so local commits never passed the registry gate at all.
#     Fix: copy the tracked hook; never regenerate it.
#
#  2. HOOKS was hardcoded to "$ROOT/.git/hooks". In a submodule checkout "$ROOT/.git" is
#     a *file* (a gitdir pointer), not a directory, so `mkdir -p` failed and `set -e`
#     aborted the script before it installed anything at all:
#       mkdir: cannot create directory '.../orig-hub/.git': Not a directory
#     Fix: ask git for the real path with `git rev-parse --git-path hooks`, which is
#     correct for standalone checkouts, submodules and linked worktrees alike.
#
# The script now also *verifies* what it installed, because defect 1 was invisible for
# months precisely because nothing compared the installed hook against the tracked one.
#
# BUG-158 (2026-10) — two further defects, both "installed but never executed":
#
#  3. ROOT used to come from `git rev-parse --show-toplevel`. In a monorepo view that
#     resolves to the *superproject* (framework) when orig-hub is not registered as its
#     own repository (see INC-001: orig-hub/.git is ignored in some checkouts), so the
#     hooks landed in framework/.git/hooks -- a directory git never reads, because the
#     outer repo sets `core.hooksPath = NUL` (a Windows device name: a path that does not
#     exist; git then looks ONLY there and silently runs nothing).
#     Fix: derive ROOT from this script's own location and REFUSE to install when that
#     location is not its own git worktree root. Installing into the superproject is
#     never the right answer -- it is exactly how "gates exist but never fire" happens.
#
#  4. The effective hooks directory is whatever `core.hooksPath` says, and it can be
#     poisoned from *any* config scope (system/global/outer repo). An inherited
#     `hooksPath=NUL` (or any path outside this repo) makes every installed hook dead.
#     Fix: pin `core.hooksPath` **locally for this repository only** to this repository's
#     own hooks directory, then read it back through git and assert the hooks are really
#     there and executable. `--local` writes the .git/config of *this* repo (for a
#     submodule: <superproject>/.git/modules/<name>/config); it never touches
#     global/system config and never the superproject's own settings.
# ============================================================
set -eu

die() {
  echo "install-hooks: FAIL - $1" >&2
  exit 1
}

# --- 0. Where are we? (BUG-158: from the script, never from --show-toplevel) ---
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$ROOT is not a git worktree -- run this script from inside the orig-hub checkout"

# `--show-prefix` is empty exactly when $ROOT *is* the top level of its worktree --
# comparing path strings would break on MSYS (drive letters get rewritten), so ask git instead.
PREFIX=$(git -C "$ROOT" rev-parse --show-prefix 2>/dev/null || echo "<not-a-worktree>")
[ -z "$PREFIX" ] \
  || die "$ROOT is NOT its own git worktree root (git reports subpath '$PREFIX').
       This checkout is part of a superproject: hooks installed here would be written into
       the superproject's .git/hooks, which its own core.hooksPath usually disables.
       Register orig-hub as its own repository (submodule or standalone clone) first."

# --- 1. Pin hooksPath to THIS repo's own hooks dir (local config only) ---
GITDIR=$(git -C "$ROOT" rev-parse --absolute-git-dir)
OWN_HOOKS="$GITDIR/hooks"
CURRENT_HOOKSPATH=$(git -C "$ROOT" config --local --get core.hooksPath 2>/dev/null || true)
if [ "$CURRENT_HOOKSPATH" != "$OWN_HOOKS" ]; then
  # Any other value (e.g. "NUL", ".githooks", a superproject path) either points nowhere
  # or outside this repo -- both mean "hooks never run". --global/--system are never used.
  git -C "$ROOT" config --local core.hooksPath "$OWN_HOOKS" \
    || die "cannot set core.hooksPath locally (needed to escape an inherited hooksPath='$CURRENT_HOOKSPATH')"
  echo "core.hooksPath: '${CURRENT_HOOKSPATH:-<unset>}' -> '$OWN_HOOKS' (local config only)"
fi

# Ask git where hooks actually live now -- never assume .git/hooks (submodule/worktree/BUG-187).
HOOKS=$(git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks)
[ "$HOOKS" = "$OWN_HOOKS" ] \
  || die "git would look for hooks in '$HOOKS', expected '$OWN_HOOKS'.
       Fix the offending core.hooksPath (git config --show-origin --get core.hooksPath)."
mkdir -p "$HOOKS"

# Copy a tracked hook. Missing source is a hard failure: silently skipping it would
# recreate the "gate long idle, nobody noticed" failure mode this script exists to prevent.
install_hook() {
  name="$1"
  src="$ROOT/scripts/hooks/$name"
  if [ ! -f "$src" ]; then
    echo "install-hooks: FAIL - $src missing (hooks have a single tracked source)" >&2
    exit 1
  fi
  cp "$src" "$HOOKS/$name"
  chmod +x "$HOOKS/$name"
}

install_hook pre-commit
install_hook commit-msg
install_hook pre-push

echo "installed hooks into $HOOKS:"
ls -1 "$HOOKS" | grep -v '\.sample$' || true
echo "git reads hooks from: $(git -C "$ROOT" rev-parse --git-path hooks)"

# Prove the installed hooks really are the tracked revisions AND are executable:
# "installed" is only true when git can execute it (BUG-158 判据 3).
rc=0
for name in pre-commit commit-msg pre-push; do
  if diff -q "$ROOT/scripts/hooks/$name" "$HOOKS/$name" >/dev/null 2>&1; then
    echo "  $name: IDENTICAL to scripts/hooks/$name"
  else
    echo "  $name: DIFFERENT from scripts/hooks/$name" >&2
    rc=1
  fi
  if [ -x "$HOOKS/$name" ]; then
    echo "  $name: executable"
  else
    echo "  $name: NOT executable (git would skip it)" >&2
    rc=1
  fi
done
exit $rc
