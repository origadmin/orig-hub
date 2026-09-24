# 本轮交付：编辑器报错归因 + 门禁失效修复 + BUG-156 库定位纠错

## 一、用户报「大量 EBADF / EPIPE + missing critical components」

**结论：与本项目仓库无关，本仓无可动作。**

- 报错来自宿主编辑器的**进程 fd 生命周期**问题：`safe-delete-common.sh:59` 以
  裸调用方式启动 node 守卫脚本（`NODE_OPTIONS= "$NODE_BIN" "$GUARD" check ...`），
  **未重定向 stdout/stderr**，子进程继承父进程 fd；父进程退出后管道对端关闭，
  子进程一写就是 `EBADF` / `EPIPE`。
- 报错文案 `missing critical components` 在 `app.asar.unpacked/`、`app.asar`、
  `cli/dist/*.js` 中**全文搜索均无命中** —— 是宿主应用内置文案，**不由本仓产出**。
- 诱因之一是工作区过大（未跟踪文件一度 **529** 个），已降至 491。
  **但这不是根因** —— 根因在宿主侧，只能向宿主报 issue。

## 二、★ 污染门禁完全失效 —— 已修（BUG-157，提交 `294a2788`）

**这是本轮真正的项目侧缺陷。** `AGENTS.md` §7 第 134-135 行早已预警：

> 历史教训：pre-commit 曾无条件 `exec` 一个从未入库的脚本 → 恒 exit 127 把所有提交锁死；
> 随后改成「缺了就跳过」，**污染门禁又长期空转（根目录因此积了残留）**。

本档就是**那句预言的实际发生**：仓库根积了 **46 个**探针残留文件
（`.tmp-*.txt` / `.zz*.txt` / `.chk2.txt`，最大单个 306 KB），
`check-pollution.sh` **恒 `EXIT=0`，一次都没报**。

### 三个独立同向的漏洞

| # | 漏洞 | 机制 |
|---|---|---|
| 1 | 根白名单检查**从未执行** | `git rev-parse --show-toplevel` 解析到外层 monorepo 根，orig-hub 的 staged 路径全带 `projects/orig-hub/` 前缀 → 被 `case "$f" in */*) : ;;` 全部跳过 |
| 2 | 临时文件规则只认**后缀** | 只匹配 `*.tmp`，而实际残留是 `.tmp-find2.txt`（`.tmp-` 是**前缀**）；`.gitignore` 的 `*.tmp` 同向失效 |
| 3 | 只看 `git diff --cached` | 残留从未 `git add` → 查不到。「未跟踪 ≠ 无污染」与 §6 口径不一致 |

### 修法与反向证伪

改用**脚本自定位**（由 `$0` 所在目录反推项目根）。
⚠️ 实施者发现并纠正了一个反直觉事实：**`--show-prefix` 在 monorepo 根返回空串**，
所以「剥前缀」这条自然的修法**根本不通**。

**我用自己构造的输入独立证伪**（未采信实施者脚本）：

```
根 .tmp-evidence-check.txt  →  EXIT=1（两条规则同时命中）  修前 EXIT=0
docs/ 下正常 .md            →  PASS（不误伤）
```

46 个残留按最高规则**未删除**，整体搬移至
`%TEMP%\orighub-root-residue-20260923-205001\`（46 文件 / 577,955 字节，逐一回读校验）。

## 三、★★ BUG-156「在产库」连续误判两次 —— 已用 API 指纹定案

**我此前记录的在产命中率（16.8%）和 P4 残留（59 条演员名）都是错的。**

| 判据 | 此前记录 | 修正后（已证实） |
|---|---|---|
| 在产库 | `%LOCALAPPDATA%\OrigHub\tg\store.db` | **`%APPDATA%\Roaming\com.origadmin.orighub\tg\store.db`** |
| 在产库 `media_item` | — | **127 行**（前者是**空表**） |
| 命中率 | 16.8% | **4.1%（38/917）** |
| 单 `#` 词 ⇒ P4 | 59 条 | **0 条** |

### 定案方法（可复用）

取**运行中后端** `127.0.0.1:9877/api/media/items` 首条记录的**完整 `filePath`**，
在各候选库做精确 SQL 匹配：

```
API 首条: id=404  ...\Roaming\com.origadmin.orighub\tg\downloads\9月21日(11)--...mp4
  Roaming\com.origadmin.orighub\tg\store.db  →  HIT id=404  ✅
  Local\OrigHub\tg\store.db                  →  no match（media_item 为空表）
  Temp\orighub_probe2\store.db               →  no match
  Temp\orighub_probe\store.db                →  no match（空表）
```

**在产库上 38/38 命中都是多 `#` 词且首词即真剧名**（`#ai成人短剧 #AI短剧 … #铁达尼号 #黑人`）
⇒ **修复后 100% 受益，P4 = 0，P4 判据在产库满足**。
那 59 条演员名（`#田曦薇` `#毛晓彤` …）**只存在于空表的废弃副本**，三个真库都查不到。

**因此：此前给出的 4 个 P4 处置方案全部撤回**（无在产依据），BUG-156 置 `fixed`。

## 四、产物与提交

| 提交 | 内容 | 外层可见性 |
|---|---|---|
| `294a2788` | 门禁修复 `check-pollution.sh`（+181 行） | `cat-file -t` → `commit` ✅ |
| `72db24fa` | BUG-156 修正 + BUG-157 建档 + 索引更新 | `cat-file -t` → `commit` ✅ |

- `docs/bugs/BUG-157.md` — 新建（门禁缺陷，`fixed`）
- `docs/bugs/BUG-156.md` — 现象/结论/P4 三处数字修正，状态 `fixed`
- `docs/bugs/README.md` — BUG-156 索引行 `open`→`fixed`，新增 BUG-157 行
- 索引回读校验：两行均 4 列，状态 `fixed`、模块 `engine`/`build` 合法
- 门禁自检：`## 验收证据` 非空（BUG-156 7949 字符 / BUG-157 871+ 字符）✅

## 五、教训（已写入 MEMORY.md）

1. **「选小的那个数字」≠「选对的那个数字」** —— 口径正确的前提是**总体正确**；
   总体必须靠**独立证据锚定**，不能靠目录名或脚本里的字符串标签。
2. **命名/注释声称的「在产」不等于实际在产** —— `"production-app"` 是个标签，不是证据。
3. **计数为 0 先怀疑工具** —— `ls -1` 对 dot-file 返回空 ≠ 文件丢失，
   `du -sb` 的 577,955 字节才是真凭据。

## 六、★ 第二项基础设施缺陷：钩子恒不生效（BUG-158，`open`）

修完 BUG-157 后我追问「这门禁为什么坏了没人发现」，答案指向更底层的缺陷：

```
git config --get core.hooksPath                        → NUL
git rev-parse --path-format=absolute --git-path hooks  → framework/NUL  ← 不存在
ls .git/hooks/                                         → 仅 *.sample
```

`NUL` 是 Windows 空设备名。**git 设了 `core.hooksPath` 后就只从该路径找钩子**，
不回落 `.git/hooks/` ⇒ **`pre-commit` 与 `commit-msg` 一个都不执行**。
写 `NUL` 的人本意是「禁用钩子」，实际语义是「去一个不存在的目录找钩子」。

而 `AGENTS.md` §7 把本地钩子标为**必需**。**文档声称的能力并不存在。**

**与 BUG-157 构成因果关系**：BUG-157（门禁逻辑失效）长期不被发现，
**正是因为 BUG-158（钩子根本没挂上）**。两者叠加 = 以为有两道防线，实际一道都没有。
这也是 `AGENTS.md` §7 那句历史教训的下一环：钩子 exit 127 锁死 → 改「缺了就跳过」
→ 门禁长期空转 → **连空转都没有**。

`install-hooks.sh` 还叠加了**同一个 `--show-toplevel` 错位**：在 orig-hub 内跑会解析到外层，
装进 `framework/.git/hooks/` —— 还是那个被禁用的目录。**执行了也没用。**

**未擅自修改**（涉 `.git/config`，属你禁止擅动区）。三个处置方案与 4 条可证伪判据已写入档，
等你裁定。

## 七、INC-001 两项未闭环的取证进阶

- **§8.1「带斜杠引用名无法落盘」已复现**：`git 2.55.0.windows.3` 上
  `git update-ref refs/tags/probe-nested/test HEAD` → **exit=0，但引用不产生、
  文件不落盘、packed-refs 无记录**。**可排除 `hooksPath` 因素**（該配置只管钩子），
  指向 git for Windows 对多级嵌套名的处理。探针未留痕，`fsck` 仍 0 错误。
- **§8.2 影响面比原记录更大**：原记录只写「外层失效」，实际因 orig-hub 的提交走外层仓，
  **orig-hub 依赖的钩子同样被屏蔽**。已交 BUG-158 接管，避免两处记录漂移。

## 八、产物与提交

| 提交 | 内容 | 外层可见性 |
|---|---|---|
| `294a2788` | 门禁修复 `check-pollution.sh`（+181 行） | `commit` ✅ |
| `72db24fa` | BUG-156 修正 + BUG-157 建档 + 索引 | `commit` ✅ |
| `c35007c3` | BUG-158 建档 + INC-001 §九 追加取证 | `commit` ✅ |

**当前缺陷总账**（用门禁自己的 `parse_index_row` 统计）：**158 条，编号 1–158 连续，0 行未解析**；
`fixed` 125 / `closed` 3 / `wontfix` 2 / **未闭环 28**（open 26 + partial 1 + in_progress 1）。

## 九、教训（已写入 MEMORY.md）

1. **「选小的那个数字」≠「选对的那个数字」** —— 口径正确的前提是总体正确；
   总体必须靠**独立证据锚定**，不能靠目录名或脚本里的字符串标签。
2. **命名/注释声称的「在产」不等于实际在产** —— `"production-app"` 是标签，不是证据。
3. **计数为 0 先怀疑工具** —— `ls -1` 对 dot-file 返回空 ≠ 文件丢失。
4. **「配置里写了」≠「能力生效」** —— `install-hooks.sh` 会打印
   `installed hooks into ...`，但装进的是被屏蔽的目录。
   **声称生效必须用「故意违规被拦下」来证明。**
5. **统计前先看解析器源码** —— `parse_index_row` 刻意「取倒数两列」以容忍标题含 `|`；
   用朴素 `split('|')` 会把 3 行好数据误判为坏数据。

## 十、待你拍板（3 项）

1. **BUG-158 处置**：①恢复钩子（unset `hooksPath` + 修自定位 + 用故意违规提交验证真拦住）
   / ②接受无钩子并把 §7 文档改成一致 / ③维持现状仅补文档。
   ①②③ 都满足「文档与实际一致」，但只有 ① 能兑现 §7 的承诺。
2. **门禁是否扩到「未跟踪文件」**：目前仍 staged-only，残留不 `git add` 就查不到。
   扩扫描会引入构建产物/AI 目录噪声，**需先定白名单**，我未擅自扩大。
3. **git 仓库拓扑缺陷**（`orig-hub/.git` 被忽略、`.git/refs/**` 写入静默失败）：
   按你指令**未动**，等你明确授权。

