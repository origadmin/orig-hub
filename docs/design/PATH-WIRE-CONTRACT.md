# 路径出口契约：对外一律 `/`

> 2026-10-22 用户报「windows 和 linux 的路径问题，看到返回的数据 `\` 和 `/` 使用混乱，
> 有没有办法标准化一下？」——本文是回答：**有，而且只有一条规则**。
>
> 状态：已落地（daemon + orig-tg 全部出口）+ 有闸门（`scripts/verify_path_wire.py`）。

## 一、问题不是"某一处写错了"

`to_string_lossy()` 在 Windows 上**必然**吐出 `D:\OrigDown\a.zip`；而
`normalize_dir()` 只在被显式调用到的地方生效。于是同一条"路径该怎么写"的规则
散落在几十个出口上，谁新增一个端点谁就可能再吐一个 `\`。

活栈实测到的三个并存形态（同一个目录）：

| 出口 | 实际值 | 来源 |
| --- | --- | --- |
| `GET /api/files` → `files[].path` | `D:\OrigDown\a.zip` | `to_string_lossy()` |
| `GET /api/config` → `effective_download_root` | `D:/OrigDown` | `dir_out()`（BUG-357） |
| `GET /api/tg/config` → `downloadDir` | `D:\OrigDown` | `to_string_lossy()` |

更糟的一种：`managed_roots` **同一个数组里**下载根是 `D:\OrigDown`（`to_string_lossy`）、
用户根是 `D:/Other`（`normalize_dir`）——前端按字符串去重/比较全部失效。

## 二、规则只有一条

**凡是给外面看 / 给外面比的路径，一律用 `/`。**

实现：`orig_core::paths::to_wire(&Path) -> String` 与 `to_wire_str(&str) -> String`，
内部复用已有的 `normalize_dir`（`\`→`/`、折叠连续分隔符、保留 UNC 前导 `//`、
修剪尾部分隔符但保留盘根 `C:/`）。

### 为什么是 `/` 而不是 `\`

| | 用 `/` | 用 `\` |
| --- | --- | --- |
| Windows 文件 API（`std::fs`、`CreateFileW`） | ✅ 全接受 | ✅ |
| Linux / macOS | ✅ 唯一分隔符 | ❌ 不是分隔符，会变成文件名的一部分 |
| JS 字符串 / URL / CSS | ✅ 无歧义 | ❌ `\` 是**转义字符**（`"C:\new"` = `C:` + 换行） |
| JSON 显示 | ✅ 无需转义 | ❌ 必须写成 `\\`，日志里看到的是双反斜杠 |

结论：统一成 `/` **不丢失任何能力**，只是把"两种都行"收敛成"一种形态"。

### 入口侧仍然两种都收

`to_wire` 只用于**出口**。入口（用户手输、前端回传、HTTP 查询参数）继续接受
`\` 和 `/`：`normalize_dir` 先规范化再落库/比较。
**不要**拿 `to_wire` 的返回值替换 `PathBuf` 去参与 `starts_with` 等路径运算——
`/` 字符串只用于出口。

## 三、落地清单（2026-10-22）

### orig-daemon

| 位置 | 字段 |
| --- | --- |
| `files.rs::to_fact` | `files[].path`（文件域每行的主键兼展示值） |
| `files.rs::list_files` | `roots[]` |
| `files.rs::delete_file` | 回显 `path`（前端拿它匹配本地列表，必须同形态） |
| `fsbrowse.rs` | `roots[].name` / `roots[].path` / 目录条目 `path` / `parent` / `resp.path` / `quick_roots` / 4 条错误消息 |
| `routes.rs::dir_out` | **实现收敛到 `to_wire`**（原先是第二份实现，BUG-357 引入） |
| `routes.rs` PUT `/api/config/download` | `download_dir` / `default_download_dir` / `effective_download_root` / `library_root` |
| `activity.rs`、`state.rs` | `EngineRow.output`（`/api/activity` 与 `/api/downloads` 共用同一个结构，两处必须同形态） |

### orig-tg

| 位置 | 字段 |
| --- | --- |
| `cache.rs::house_downloaded_bytes` | `HousedBytes.item_path` / `absolute_path`（成功与降级两条分支） |
| `media.rs::attach_bytes_presence` | `items[].absolutePath` |
| `media.rs::scan` | `ScannedFile.path`（与同屏的 `dir` 一致） |
| `media.rs` 导出回执 | `targetDir` / `exportDir` / `manifestPath` |
| `routes.rs::effective_download_dir` | `downloadDir`（`GET` 与 `PUT /api/tg/config` 共用） |
| `routes.rs` | `libraryDir` × 2、`/api/fs/list` 的 `path`、`resolve_cache_dir` 返回值、`cached_path` 返回值 |
| `store.rs::managed_roots` | 下载根（此前与用户根形态不一致） |

### 判据

- `orig_core::paths::to_wire_emits_forward_slashes_only`：`C:\Users\x\Videos` →
  `C:/Users/x/Videos`；UNC `\\server\share\dir` → `//server/share/dir`；循环断言
  出口不含 `\`。
- `orig-tg::cache::house_falls_back_to_original_location_when_library_root_unusable`：
  降级回填的断言从 `src.to_string_lossy()` **翻转**成 `to_wire(&src)`——
  旧断言把"两种分隔符并存"钉成了正确行为。

## 四、闸门：`scripts/verify_path_wire.py`

```bash
python scripts/verify_path_wire.py --self-test    # 探测器自检，不需要活栈
python scripts/verify_path_wire.py                # 查活栈（12 个只读端点）
```

两条判据：

1. **路径类键**（键名含 path/dir/root/output/folder/location/target）的值里不得出现 `\`；
2. **任何键**下出现盘符绝对路径（`C:\`）或 UNC（`\\server\`）都算泄漏——
   路径常常藏在 `error`、`hint` 这类"非路径键"里，只查键名会漏。
   例外：`caption`/`title`/`description`/`text`/`body`/`content`/`url` 等
   用户内容字段不查（用户自己写的 caption 里可以有反斜杠）。

**为什么需要两条**：只做第 1 条，`{"error": "无权读取目录 C:\x"}` 永远查不出来；
只做第 2 条，相对路径（`chat-1/a.mp4`）根本不像绝对路径，漏判。

### 自检抓到的第一个洞（留档）

首版判据 2 用 `re.match`（只匹配字符串开头），自检用例
`{"error": "cannot read C:\\Windows"}` 报 `got=0` —— 路径嵌在句子里就漏了。
改成 `re.search` 后 10/10 通过。**这就是"反向证伪是验收的验收"的意义**：
没有自检，这个洞会一直静默地让红变绿。

### 端点不可用计失败，不计通过

`[SKIP]` 与 `[FAIL]` 都让退出码为 1。"没检查"不能被读成"没问题"。

## 五、未动（只报告）

| 位置 | 为什么不改 |
| --- | --- |
| `routes.rs` 的 `want`（推给 TG 的 `downloadDir`） | 内部值，TG 侧入口自己会规范化；不属出口 |
| `cache.rs` 内部 `absolute`（`file_len`/`inside_dir`/`age_days` 的入参） | 纯内部计算，Windows 文件 API 两种都收；不进响应 |
| `serve_local_file` 的入参 | 文件服务路径，不进 JSON |
| `store.rs::remove_managed_root` 的比较值 | 走 `paths_equal`（canonicalize 后比较），形态无关 |
| 前端 | 前端只消费，不做二次拼装；出口干净则前端无感 |

## 六、已知遗留

- `orig-tg` 的 `list_stored` 仍匹配 `caption OR c.title OR m.file_path`——
  这是「用文件属性冒充内容」的同类问题（与 TG 筛选第 1 点同源），
  **用户未点名，未动**，见 `docs/design/TG-FILTER-DOWNLOAD-EVAL.md`。
- `ScannedFile.dir` 用的是 `replace('\\', "/")` 而不是 `to_wire`——它是**相对**扫描根的
  目录名，不含盘符，行为等价；保留原实现（最小 diff），若日后要统一可一并换掉。
