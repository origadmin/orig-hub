#!/usr/bin/env sh
# ============================================================
# Install repo git hooks (hooks are NOT version-controlled).
#   sh scripts/install-hooks.sh
#
# Installs both hooks from their single tracked source under scripts/hooks/:
#   pre-commit -> scripts/hooks/pre-commit  (bug-registry + pollution gates, AGENTS.md §7)
#   commit-msg -> scripts/hooks/commit-msg  (English-only commit messages, AGENTS.md §2)
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
# ============================================================
set -eu

ROOT=$(git rev-parse --show-toplevel)
# Run from the repo root so a relative hooks path (if git ever returns one) still resolves.
cd "$ROOT"
HOOKS=$(git rev-parse --git-path hooks)
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

echo "installed hooks into $HOOKS:"
ls -1 "$HOOKS" | grep -v '\.sample$' || true

# Prove the installed hooks really are the tracked revisions.
rc=0
for name in pre-commit commit-msg; do
  if diff -q "$ROOT/scripts/hooks/$name" "$HOOKS/$name" >/dev/null 2>&1; then
    echo "  $name: IDENTICAL to scripts/hooks/$name"
  else
    echo "  $name: DIFFERENT from scripts/hooks/$name" >&2
    rc=1
  fi
done
exit $rc
