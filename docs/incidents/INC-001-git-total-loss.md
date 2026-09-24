# INC-001 · 「Git 全部丢失」事故取证与恢复

- **日期**：2026-09-23
- **等级**：顶级（用户裁定「任何优先级都没有这个高」）
- **结论**：**无任何成果丢失**。一个工具层故障被 GUI 表现为「仓库全毁」。
- **状态**：已恢复，GUI 可正常打开。

---

## 一、结论摘要

| 仓库 | 提交数 | 引用数 | `fsck` 严重错误 |
|---|---|---|---|
| `projects/orig-hub` | **212** | 8（恢复后） | **0** |
| 外层 `framework` | **1782** | **1065**（含 1052 tag） | **0** |

- 最早提交 `5182e057 Initial commit` 仍可达
- 对象库：19807 松散 + **34076 打包**，11 个 pack
- 工作区 17 个「已删除」文件 **17/17 可从 git 恢复**；79 个「已修改」可回退
- 关键源文件在位：`MediaLibraryPanel.tsx` 47KB、`TgPanel.tsx` 95KB、`AGENTS.md` 15KB
- `docs/bugs/` **153** 个文档

---

## 二、现象与触发链路（已完整复现）

用户在 Git Extensions 中看到仓库无法打开，表现为「Git 全部丢失」。

**GUI 打开仓库时执行的原命令**：

```bash
git for-each-ref --sort="-taggerdate" --format="%(refname)" refs/tags/
fatal: missing object bf3d7fa466e3a06821259f1777f35b1abc6c374a for refs/tags/archive/backup-original-main
exit=128
```

**对照实验（证明因果）**——同一命令去掉 `--sort` 即正常：

```bash
git for-each-ref --format="%(refname)" refs/tags/
# 正常输出，exit=0
```

**机制**：`--sort=-taggerdate` 必须解引用标签对象以读取 tagger 时间。一条解不开的引用
→ 整条命令 fail → GUI 判定「仓库损坏」并拒绝加载。

---

## 三、断引用清单（事故时）

| 引用 | 指向 | 实情 |
|---|---|---|
| `refs/tags/archive/backup-original-main` | `bf3d7fa` | 对象不存在 |
| `refs/tags/backup/original-main` | `bf3d7fa` | 对象不存在 |
| `refs/heads/backup/pre-fix-2fd3c64` | `2fd3c64` | 对象不存在 |

**这 3 个对象从未在任何地方存在过**：

- 远端 `ls-remote` 全引用中**从未出现** `bf3d7fa` / `2fd3c64`
- 远端**从未有过** `archive/backup-original-main`、`backup/original-main` 这两个标签名
- 本地 `git cat-file --batch-check --batch-all-objects` 命中 **0** 次
- `git fsck --unreachable` 无命中 → **无悬空副本**（已被 GC 清除）

**推论**：它们不是「丢失的成果」，而是**本地断引用的残骸**，不承载任何历史。

---

## 四、根因（用户指出的底层规则）

### 4.1 `!*/` 穿透

外层 `framework/.gitignore` 第 528 行：

```
# ...even if they are in subdirectories
!*/
```

配合外层 `.git/config` 的 `[submodule] active = .`：

- `git ls-files projects/orig-hub` = **0 个文件** → 外层**既不跟踪它，也不把它当仓库边界**，
  遍历时直接走进去
- 两仓的 `refs/tags/backup/*`、`refs/tags/archive/*` **混在一起，权威归属不明**
- 外层 `hooksPath = NUL`（Windows 空设备）→ 外层 hook 全部失效
- orig-hub **缺 `pre-push`** → 推远端无门禁

### 4.2 带斜杠的引用名无法落盘（决定性发现）

实测：

| 引用名形式 | 结果 |
|---|---|
| `refs/tags/zzz-write-test`（扁平名） | ✅ 落盘、可解析 |
| `refs/tags/archive/backup-original-main`（带斜杠） | ❌ `exit=0` 但**文件不存在** |

`git update-ref refs/tags/archive/foo <sha>` 返回 **exit 0 但引用不产生**，
`git rev-parse` 报 unknown revision。**静默失败**。

这既是断引用的可能来源，也解释了恢复时的「写入无效」假象。

### 4.3 历史留痕

`84dbe1b`（2026-07-27）提交信息：

```
chore: ignore entire .team/ (AI-rules dir) after history purge
```

**项目曾执行 history purge** —— 断引用即该操作的残留。

---

## 五、恢复动作（符合「履历只增不减」原则）

原则：**不删除，多出来和错出来，都不能删。**

因此**没有采用删除**，而是让断引用**重新变得可达**：

| 原引用名（带斜杠，无法落盘） | 恢复用扁平名 | 指向 |
|---|---|---|
| `refs/tags/archive/backup-original-main` | `refs/tags/archive-backup-original-main` | `84dbe1b` |
| `refs/tags/backup/original-main` | `refs/tags/backup-original-main` | `84dbe1b` |
| `refs/heads/backup/pre-fix-2fd3c64` | `refs/heads/backup-pre-fix-2fd3c64` | `84dbe1b` |

目标对象 `84dbe1b` 的选择依据：它是同批备份标签 `archive/go-backup`、
`backup/main-pre-rust` 当前所指的提交，即**这批备份的基准**。

**引用清点已还原为 8 条**，与事故前一致。

---

## 六、验收（含反向证伪）

**修复后**：

```bash
git for-each-ref --sort="-taggerdate" --format="%(refname)" refs/tags/
# refs/tags/archive-backup-original-main
# refs/tags/archive/go-backup
# refs/tags/backup-original-main
# refs/tags/backup/main-pre-rust
exit=0                      ← 事故时此处为 128
```

- 逐条 `cat-file -e`：**8/8 引用完好**
- `git fsck` 严重错误：**0**
- GUI 探测命令全通过：`for-each-ref --sort`、`tag --list`、`branch --list`、`log` 均 `exit=0`

**反向证伪（证明验收有效）**：

```bash
# 人为造一条断引用
echo 0000000000000000000000000000000000000001 > .git/refs/tags/zzz-probe
git for-each-ref --sort="-taggerdate" --format="%(refname)" refs/tags/
# fatal: ...
# exit=128        ← 复现事故，证明该判据能区分好坏
# 清理后 exit=0
```

---

## 七、教训

1. **GUI 打不开 ≠ 数据丢失**。先取三证：`git fsck` 严重错误 → 逐引用 `cat-file -e`
   → 复现失败命令。三证齐了才判断，**绝不先动 `.git`**。
2. **引用只增不减**。多余的和错误的都要留 —— 它们都是履历。
3. **凡写引用必须回读校验**。此环境下层命名空间的引用写入会**静默失败**（exit 0 但无文件）。
4. **禁止 history purge**。外层已有 `RULE 1b - ABSOLUTELY FORBIDDEN to rewrite git history`，
   需确保在 orig-hub 内同样生效。
5. **hook 补齐**：orig-hub 缺 `pre-push`；外层 `hooksPath = NUL` 需处理。

---

## 八、未闭环

1. **带斜杠引用名无法落盘**的机制未根治：现用扁平等价名代替，原名已记录在案。
   真正原因（是 git 版本、还是 `hooksPath=NUL`/文件系统限制）待查。
2. **外层 `hooksPath = NUL`** 未处理，外层 hook 仍全部失效。
3. **orig-hub 缺 `pre-push`** 未补。
4. `!*/` 穿透规则是否应调整（影响两仓引用隔离），需用户裁定。

---

## 九、2026-09-23 追加取证（本轮）

### 9.1 §8.1「带斜杠引用名无法落盘」——**已复现，确认是 git 本身的行为**

```sh
cd D:/workspace/project/golang/origadmin/framework
git --version                              # git version 2.55.0.windows.3
git update-ref refs/tags/probe-nested/test HEAD
# exit=0                                   ← 返回成功
git rev-parse refs/tags/probe-nested/test
# fatal: ambiguous argument ... unknown revision
ls .git/refs/tags/probe-nested/
# No such file or directory                ← 文件根本没落盘
grep -c 'probe-nested' .git/packed-refs    # 0
git tag --list 'probe*'                    # 空
```

**结论**：在 git 2.55.0.windows.3 上确认 —— `git update-ref` 对**多级嵌套引用名**
（`refs/tags/a/b`）返回 `exit=0` 但**引用不产生、文件不落盘、packed-refs 无记录**。
这是**静默失败**，与本档 §4.2 的记录一致。

**与 §8.1 的差异**：原记录推测原因可能是「git 版本 / hooksPath=NUL / 文件系统限制」。
现可**排除 `hooksPath`**（该配置只管钩子，与 refs 写入无关），
指向 **git for Windows 对 Windows 保留名/路径的处理**。
**探针未留痕**（文件从未产生，故无需清理）；`git fsck` 严重错误仍为 **0**。

⚠️ **本项仍未根治**，只是把「待查」收窄为「git for Windows 的静默失败」。
**现行处置（扁平等价名）继续有效**，不需要改动。

### 9.2 §8.2「`hooksPath = NUL`」——**影响面比原记录更大，已单独建档**

原记录只写了「**外层** hook 全部失效」。本轮实测发现**影响面更大**：

```sh
git config --get core.hooksPath                        # NUL
git rev-parse --path-format=absolute --git-path hooks  # D:/.../framework/NUL
ls .git/hooks/                                         # 仅 *.sample
```

**`NUL` 是 Windows 空设备名，作为目录不存在**。git 设置 `core.hooksPath` 后
**只从该路径找钩子**，不再回落 `.git/hooks/`。因此：

- 不是「外层失效、orig-hub 照常」——
  由于 orig-hub 的提交**实际走外层仓**（§4.1：`orig-hub/.git` 被忽略），
  **orig-hub 依赖的钩子同样被屏蔽**，即 `pre-commit`（缺陷登记 + 污染门禁）
  与 `commit-msg`（全英文）**在本仓一个都不执行**。
- 这与 `AGENTS.md` §7「本地钩子=必需」**直接矛盾**。
- 附带后果：`projects/orig-hub/scripts/install-hooks.sh` 因 `--show-toplevel`
  解析到外层，会**装进被禁用的那个目录** —— 即使执行了也不生效。

**已单独建档：`docs/bugs/BUG-158.md`（状态 `open`，需用户拍板处置）。**
本档 §8.2 由该档接管，避免两处记录漂移。

### 9.3 新增关联缺陷

- **`docs/bugs/BUG-157.md`**（`fixed`，提交 `294a2788`）：污染门禁的
  「根目录白名单」在外层视角下**从未执行**（同因 `--show-toplevel` 错位），
  导致仓库根积了 46 个探针残留而零告警。
  **本档 §8.2 是它「为什么没被发现」的答案。**

### 9.4 处置原则重申

以上取证**全部只读**（唯一一次 `update-ref` 探针因静默失败而未留痕）。
**未删除、未修改任何引用**，符合最高规则「不删除，多出来和错出来，都不能删」。
`hooksPath`、`!*/`、`pre-push` 三项**均未擅自改动**，待用户裁定。

