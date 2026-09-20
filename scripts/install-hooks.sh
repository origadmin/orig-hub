#!/usr/bin/env sh
# 安装 git 钩子（钩子不入库，新克隆/换机器必须执行一次）。
#
# 为什么要这个脚本：钩子目录 `.git/hooks/` 不受版本控制，历史上它曾指向一个
# 从未入库的脚本（`scripts/check-pollution.sh`），导致所有提交恒失败且无人能定位。
# 现在钩子的**权威副本入库**在 `scripts/hooks/`，本脚本负责安装与对账。
#
# 用法：bash scripts/install-hooks.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/hooks"
DST="$ROOT/.git/hooks"

[ -d "$SRC" ] || { echo "install-hooks: FAIL - $SRC 不存在" >&2; exit 1; }
[ -d "$DST" ] || { echo "install-hooks: FAIL - $DST 不存在（不是 git 仓库？）" >&2; exit 1; }

for h in pre-commit commit-msg; do
  [ -f "$SRC/$h" ] || { echo "install-hooks: FAIL - 缺少 $SRC/$h" >&2; exit 1; }
  cp -f "$SRC/$h" "$DST/$h"
  chmod +x "$DST/$h"
  echo "install-hooks: installed .git/hooks/$h"
done

# 自检：两条钩子在无参数/空消息下必须能跑完（不能因依赖缺失炸在无关位置）。
printf 'chore: hook self-test\n' > "$DST/.self-test-msg"
sh "$DST/commit-msg" "$DST/.self-test-msg" || {
  echo "install-hooks: FAIL - commit-msg 自检未通过" >&2; rm -f "$DST/.self-test-msg"; exit 1; }
rm -f "$DST/.self-test-msg"
echo "install-hooks: OK - commit-msg 自检通过"

# 自检：pre-commit 的两条**必需**依赖都必须在库内 —— 缺一个就等于装了半个门禁，
# 必须在安装阶段就吵出来（历史两次事故：脚本从未入库 → 提交恒 127；改成静默跳过后门禁空转）。
for dep in scripts/check-bugs.py scripts/check-pollution.sh; do
  [ -f "$ROOT/$dep" ] || {
    echo "install-hooks: FAIL - 缺少必需依赖 $dep（pre-commit 会直接失败，拒绝装半个门禁）" >&2; exit 1; }
done
if sh "$DST/pre-commit" >/dev/null 2>&1; then
  echo "install-hooks: OK - 钩子已安装，两条必需依赖在库，当前工作树通过 pre-commit 门禁"
else
  echo "install-hooks: 钩子已安装，但当前工作树**未通过** pre-commit 门禁（以下为其真实输出）：" >&2
  sh "$DST/pre-commit" || true
  echo "install-hooks: 先修工作树上的污染，再提交。" >&2
fi
