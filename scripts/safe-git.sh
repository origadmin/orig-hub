#!/usr/bin/env bash
# safe-git: orig-hub 开发期专用 git 封装。
#
# 用户铁律 (2026-09-24, 经多轮破坏事件后确立):
#   开发期仅允许 commit(+add) 与【只读/取证】命令。
#   一切结构/写命令必须在调用时被拦截 —— 这是机制级防越级破坏,
#   前 99 次失败正是因为只靠文本规则、缺机制拦截。
#
# AI 行为约束 (强制, 违反即越权):
#   1. 任何 git 操作必须经由本脚本, 禁止直接调用 git 二进制。
#   2. AI 不得主动发起以下任一操作, 除非用户在消息中明确写出该命令并授权:
#      init / clone / remote(add|set-url|rm) / branch(创建|删|改) / tag(创建) /
#      config(set) / submodule / worktree / mv / rm / gc / repack /
#      merge / rebase / reset / checkout / restore / clean / cherry-pick / revert /
#      fetch / pull / push / filter-repo / commit --amend / --no-verify
#   3. 本脚本对任何上述命令返回 exit 1 并打印所需授权说明; AI 见到拦截必须停下, 不得绕过。
set -u
GIT_BIN="git"

sub=""
for a in "$@"; do
  case "$a" in
    -*) ;;
    *) sub="$a"; break ;;
  esac
done

block() {
  echo "safe-git 拦截: 子命令 '$1' 在 orig-hub 开发期被禁止(须用户显式授权具体命令)。" >&2
  echo "  允许写: commit / add" >&2
  echo "  允许只读/取证: status diff log show rev-parse reflog fsck cat-file blame" >&2
  echo "    whatchanged shortlog rev-list grep ls-files ls-remote describe name-rev" >&2
  echo "    verify-pack for-each-ref check-ignore check-attr show-ref merge-base" >&2
  echo "    branch -a/-r/-v | remote -v | tag -l | config --get/--list | stash list/show | symbolic-ref(只读)" >&2
  echo "  需要授权: init clone remote(add|set-url|rm) branch(创建/删/改) tag(创建)" >&2
  echo "    config(set) submodule worktree mv rm gc repack merge rebase reset" >&2
  echo "    checkout restore clean cherry-pick revert fetch pull push filter-repo commit --amend --no-verify" >&2
  exit 1
}

[ -z "$sub" ] && { echo "safe-git: 未指定子命令" >&2; exit 1; }

# ---- 显式结构/危险命令拦截 (含 init/clone/gc/repack, 防止 AI 擅自建仓/丢对象) ----
case "$sub" in
  init|clone|submodule|worktree|mv|rm|gc|repack|filter-repo|filter-branch|\
  merge|rebase|reset|checkout|restore|clean|cherry-pick|revert|\
  fetch|pull|push|am|apply|notes)
    block "$sub" ;;
esac

# ---- commit: 禁止改写历史的姿势 ----
if [ "$sub" = "commit" ]; then
  for a in "$@"; do
    case "$a" in
      --amend|--no-verify|-C|-c|--reuse-message|--fixup|--squash) block "commit $a" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- add: 放行(精确路径由 pre-commit 顶层校验兜底) ----
if [ "$sub" = "add" ]; then
  exec "$GIT_BIN" "$@"
fi

# ---- remote: 仅只读 ----
if [ "$sub" = "remote" ]; then
  for a in "$@"; do
    case "$a" in
      add|remove|rm|set-url|set-head|prune|update) block "remote $a" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- branch: 仅列举, 禁创建/删除/改名 ----
if [ "$sub" = "branch" ]; then
  for a in "$@"; do
    case "$a" in
      -a|-r|-v|-vv|--list|--contains|--merged|--no-merged|--verbose) ;;
      -d|-D|-m|-M|--delete|--move) block "branch $a" ;;
      -*) ;;
      *) block "branch <name>(创建)" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- tag: 仅列举 ----
if [ "$sub" = "tag" ]; then
  for a in "$@"; do
    case "$a" in
      -l|--list) ;;
      -*) block "tag $a" ;;
      *) block "tag <name>(创建)" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- config: 仅读取 ----
if [ "$sub" = "config" ]; then
  for a in "$@"; do
    case "$a" in
      --get|--get-all|--get-regexp|--list|--bool|--int|--path|--local|--global|--system|--type) ;;
      -*) block "config $a" ;;
      *) block "config <set>" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- stash: 仅 list/show ----
if [ "$sub" = "stash" ]; then
  for a in "$@"; do
    case "$a" in
      list|show|-p|--patch) ;;
      push|pop|drop|clear|save|apply|branch|store|-u|--include-untracked|--all) block "stash $a" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- reflog: 仅只读列举 ----
if [ "$sub" = "reflog" ]; then
  for a in "$@"; do
    case "$a" in
      expire|delete|drop) block "reflog $a" ;;
    esac
  done
  exec "$GIT_BIN" "$@"
fi

# ---- symbolic-ref: 仅读取(无第二位置参数) ----
if [ "$sub" = "symbolic-ref" ]; then
  n=0
  for a in "$@"; do
    case "$a" in
      -*) ;;
      *) n=$((n+1)) ;;
    esac
  done
  [ "$n" -gt 1 ] && block "symbolic-ref <set>"
  exec "$GIT_BIN" "$@"
fi

# ---- 纯只读/取证白名单 ----
case "$sub" in
  status|diff|log|show|rev-parse|fsck|cat-file|blame|whatchanged|shortlog|rev-list|grep|ls-files|ls-remote|describe|name-rev|verify-pack|for-each-ref|check-ignore|check-attr|show-ref|merge-base|version|help)
    exec "$GIT_BIN" "$@" ;;
  *)
    block "$sub" ;;
esac
