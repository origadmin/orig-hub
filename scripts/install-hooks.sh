#!/usr/bin/env sh
# ============================================================
# Install repo git hooks (hooks are NOT version-controlled).
#   bash scripts/install-hooks.sh
# Installs:
#   pre-commit -> scripts/check-pollution.sh   (pollution gate, AGENTS.md §7)
#   commit-msg -> scripts/hooks/commit-msg     (English-only commit messages, AGENTS.md §2)
# ============================================================
set -eu

ROOT=$(git rev-parse --show-toplevel)
HOOKS="$ROOT/.git/hooks"
mkdir -p "$HOOKS"

# pre-commit: pollution gate
cat > "$HOOKS/pre-commit" <<'EOF'
#!/usr/bin/env sh
exec sh "$(git rev-parse --show-toplevel)/scripts/check-pollution.sh"
EOF
chmod +x "$HOOKS/pre-commit"

# commit-msg: English-only (no CJK) — reuse tracked copy if present
if [ -f "$ROOT/scripts/hooks/commit-msg" ]; then
  cp "$ROOT/scripts/hooks/commit-msg" "$HOOKS/commit-msg"
  chmod +x "$HOOKS/commit-msg"
fi

echo "installed hooks into $HOOKS:"
ls -1 "$HOOKS" | grep -v '\.sample$'
