# orig-hub Git 安全铁律（2026-09-24 确立，机制级强制）

> 背景：orig-hub 多次被 git 操作破坏（远端丢失、越界写入、对象库被 prune 清空）。
> 前 99 次仅靠文本规则无效 —— 因为规则假设"操作者知道当前作用于哪个仓库"，而 orig-hub
> 曾嵌在 framework 工作树内、自身 `.git` 被架空，git 会沿目录向上解析到 framework，
> 让"在 orig-hub 里操作"实际上改的是 framework。本文件把约束做成 **机制级拦截**。

## 0. 仓库定位（唯一真相源）
- orig-hub 的唯一真相源是 `framework/projects/orig-hub`（嵌套于 framework 内，是 submodule）。
- 所有 git 操作只作用于这个 orig-hub 仓库；**严禁对 framework 自身的历史 / 其它仓库执行任何 git 写操作**。
- 禁止把 orig-hub 当作"独立仓库"重新 `init`、或迁移 / 克隆出脱离真相源的副本。

## 1. AI 行为约束（强制，违反即越权）
1. AI **禁止直接调用 `git` 二进制**；所有 git 操作必须经由 `scripts/safe-git.sh`。
2. AI **不得主动发起任何结构 / 写命令**，除非用户在消息中**明确写出该命令并授权**。涵盖：
   `init` / `clone` / `remote(add|set-url|rm)` / `branch(创建|删|改)` / `tag(创建)` /
   `config(set)` / `submodule` / `worktree` / `mv` / `rm` / `gc` / `repack` /
   `merge` / `rebase` / `reset` / `checkout` / `restore` / `clean` / `cherry-pick` /
   `revert` / `fetch` / `pull` / `push` / `filter-repo` / `commit --amend` / `--no-verify`。
3. safe-git 对上述任一命令返回 `exit 1` 并提示所需授权；AI 见到拦截必须停下，**不得绕过**。

## 2. 开发期唯一允许的 git 命令
- 写：`commit`（及提交所需的 `add`）
- 只读 / 取证：`status` `diff` `log` `show` `rev-parse` `reflog` `fsck` `cat-file`
  `blame` `whatchanged` `shortlog` `rev-list` `grep` `ls-files` `ls-remote`
  `describe` `name-rev` `verify-pack` `for-each-ref` `check-ignore` `check-attr`
  `show-ref` `merge-base`；以及列举类 `branch -a/-r/-v` `remote -v` `tag -l`
  `config --get/--list` `stash list/show` `symbolic-ref`(只读)

## 3. 重点封死的破坏源
- **`git init` / `git init --separate-git-dir`**：会把既有对象库重置，导致历史断裂。绝对禁止。
- **`gc` / `repack` / `prune`**：可能清空 unreachable 对象 —— 历史提交丢失的主嫌疑，重点封死。
- `reset` / `checkout --` / `restore` / `clean`：`reset` 仅当用户显式授权且明确目标时可用。
- `merge` / `rebase` / `cherry-pick` / `revert` / `filter-repo` / `commit --amend` / `--no-verify`。

## 4. 执行级护栏（机制，非文本）
- 所有 git 经 `scripts/safe-git.sh`；建议固化别名 `alias git='./scripts/safe-git.sh'`。
- `scripts/git-hooks/pre-commit` 断言"作用于 orig-hub 且 origin 为 origadmin/orig-hub"，误落其它仓库即中止。
- 安装：`cp scripts/git-hooks/pre-commit .git/hooks/pre-commit`（需用户授权后执行）。

## 5. 例外
仅当用户显式发起「git 修复任务」并在消息中写出具体命令时，方可使用上述禁止命令。
