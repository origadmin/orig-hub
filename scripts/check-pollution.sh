#!/usr/bin/env sh
# 仓库污染门禁 —— 对应 AGENTS.md §6「目录归属与污染防线」。
#
# 三条不变量（每条都能被机械判定，不靠人记）：
#   I1 仓库根只允许 4 个文件：.gitignore / AGENTS.md / README.md / download-engine.toml
#      （目录不限；根目录下的**文件**是污染高发区：交付概述、临时库、日志都往这儿落）
#   I2 仓内不得**跟踪**构建产物 / 运行时残留 / AI 工具目录
#      （`.gitignore` 拦不住的唯一原因是「先提交、后 ignore」——已跟踪的文件不受 ignore 影响）
#   I3 仓内不得存在**未忽略**的残留文件（dist_* / *.db / *.session / *.log / *.part …）
#
# 判定口径：「被 .gitignore 忽略」= 可容忍（target/、node_modules/ 物理存在是正常的）；
# 「被跟踪」或「未忽略」= 失败。这样门禁不需要对用户的本地工具目录做物理删除。
#
# 用法：sh scripts/check-pollution.sh   （由 .git/hooks/pre-commit 与 CI 同时调用）

set -u

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "check-pollution: FAIL - not inside a git work tree" >&2
  exit 1
fi
cd "$ROOT" || exit 1

ALLOWED_ROOT_FILES=".gitignore AGENTS.md README.md download-engine.toml"

# 构建产物 / 运行时残留 / AI 工具目录的路径模式（POSIX ERE，作用于仓库相对路径）
ARTIFACT_RE='(^|/)(target|target-mock|node_modules|dist|dist_[^/]*|binaries)/|\.(exe|dll|so|dylib|db|session|log|part|tmp|bak)$|(^|/)proxy-test-file\.bin$'

fail=0
report() {
  echo "check-pollution: FAIL - $1" >&2
  fail=1
}

is_allowed_root_file() {
  for a in $ALLOWED_ROOT_FILES; do
    [ "$1" = "$a" ] && return 0
  done
  return 1
}

# ---------- I1 仓库根只允许 4 个文件 ----------
root_files=$(
  {
    git ls-files
    git ls-files --others --exclude-standard
  } | awk 'index($0, "/") == 0'
)

for f in $root_files; do
  if ! is_allowed_root_file "$f"; then
    report "仓库根出现白名单外的文件：$f（AGENTS.md §6：根只允许 $ALLOWED_ROOT_FILES）"
    echo "      处置：文档移入 docs/、脚本移入 scripts/、产物移出仓库或加入 .gitignore。" >&2
  fi
done

# ---------- I2 不得跟踪产物 / AI 工具目录 ----------
tracked_bad=$(git ls-files | grep -E "$ARTIFACT_RE" || true)
if [ -n "$tracked_bad" ]; then
  report "以下产物/残留已被 git 跟踪（ignore 对已跟踪文件无效）："
  echo "$tracked_bad" | sed 's/^/      /' >&2
  echo "      处置：git rm --cached <path>，并在 .gitignore 补上对应模式。" >&2
fi

tracked_ai=$(git ls-files | grep -E '(^|/)\.(trae|claude|cursor|aider|kiro|cody|codex|codeium|augment|continue|sourcegraph|agents?)/|(^|/)CLAUDE\.md$|(^|/)\.windsurfrules$' || true)
if [ -n "$tracked_ai" ]; then
  report "以下 AI/Agent 工具文件已被跟踪（零容忍，AGENTS.md §6）："
  echo "$tracked_ai" | sed 's/^/      /' >&2
fi

# ---------- I3 不得存在未忽略的残留文件 ----------
untracked_bad=$(git ls-files --others --exclude-standard | grep -E "$ARTIFACT_RE" || true)
if [ -n "$untracked_bad" ]; then
  report "以下未忽略的残留文件存在于工作树："
  echo "$untracked_bad" | sed 's/^/      /' >&2
  echo "      处置：移出仓库（或加入 .gitignore 并确属运行时产物）。" >&2
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-pollution: OK - 根目录 4 文件白名单内，无被跟踪/未忽略的产物与残留。"
