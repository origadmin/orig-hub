#!/usr/bin/env sh
# 把本地远端跟踪引用同步到**远端真实值**，并回读校验。
#
# 背景（这是本仓库反复踩的坑，勿删本段）：
#   本环境下 .git/refs/** 的部分写入会被**静默拦截** —— `git fetch` 与
#   `git update-ref` 可能退出码 0 但值不变。于是 `origin/main` 长期停留在旧值，
#   明明远端与本地代码一致，`git status` 却显示成「main...origin/main [ahead N]」
#   甚至看似「脱离 remote」的假象。
#   本脚本绕过 ref 写入通道，直接改 .git/packed-refs 并**回读校验**。
#
# 用法：
#   sh scripts/sync-remote-ref.sh                 # 默认同步 origin/main
#   sh scripts/sync-remote-ref.sh refs/heads/foo  # 指定分支
#   sh scripts/sync-remote-ref.sh refs/heads/main origin
#
# 退出码：0 已同步且校验通过；非 0 失败（网络不通 / 校验不符），**不静默跳过**。

set -eu

REF="${1:-refs/heads/main}"
REMOTE="${2:-origin}"

BRANCH="${REF#refs/heads/}"
TRACK="refs/remotes/${REMOTE}/${BRANCH}"

GIT_DIR="$(git rev-parse --git-dir)"
PACKED="${GIT_DIR}/packed-refs"

# 1. 取远端真实值（网络失败即失败，不回落旧值）
REMOTE_SHA="$(git ls-remote "${REMOTE}" "${REF}" 2>/dev/null | awk 'NR==1 {print $1}')"
if [ -z "${REMOTE_SHA}" ]; then
  echo "sync-remote-ref: FAIL - 无法从 ${REMOTE} 读取 ${REF}（网络不通或分支不存在）" >&2
  exit 1
fi

# 2. 先试标准通道（正常情况下它会成功）
git update-ref "${TRACK}" "${REMOTE_SHA}" 2>/dev/null || true

# 3. 回读；若标准通道被静默拦截，则直接改 packed-refs
CURRENT="$(git rev-parse --verify "${TRACK}" 2>/dev/null || echo '')"
if [ "${CURRENT}" != "${REMOTE_SHA}" ]; then
  if [ ! -f "${PACKED}" ]; then
    echo "sync-remote-ref: FAIL - ${TRACK} 未同步且 ${PACKED} 不存在" >&2
    exit 2
  fi
  # 行首是 40 位 hash + 空格 + 精确 refname（行尾锚定，避免误伤前缀相同的引用）
  if grep -q "^[0-9a-f]\{40\} ${TRACK}\$" "${PACKED}"; then
    # 逐行改写，保持原有行序（packed-refs 要求字典序，只换值不改名字则顺序不变）
    awk -v ref="${TRACK}" -v sha="${REMOTE_SHA}" \
      '{ if ($2 == ref) { print sha " " ref } else { print } }' \
      "${PACKED}" > "${PACKED}.tmp"
    mv "${PACKED}.tmp" "${PACKED}"
  else
    echo "sync-remote-ref: FAIL - ${PACKED} 中无 ${TRACK}，且标准通道写入无效" >&2
    exit 3
  fi
fi

# 4. 强制回读校验（不可跳过：本环境的失败是「静默」的）
FINAL="$(git rev-parse --verify "${TRACK}" 2>/dev/null || echo '')"
if [ "${FINAL}" != "${REMOTE_SHA}" ]; then
  echo "sync-remote-ref: FAIL - 校验不符：期望 ${REMOTE_SHA}，实际 ${FINAL}" >&2
  exit 4
fi

LEFT_RIGHT="$(git rev-list --left-right --count "${TRACK}...${BRANCH}" 2>/dev/null || echo '?	?')"
echo "sync-remote-ref: OK - ${TRACK} = ${REMOTE_SHA}"
echo "sync-remote-ref: 领先/落后（左=远端独有 右=本地独有）= ${LEFT_RIGHT}"
exit 0
