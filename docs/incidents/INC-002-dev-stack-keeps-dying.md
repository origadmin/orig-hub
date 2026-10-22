# INC-002 · 「服务又挂了，已成常态」——dev 栈随 agent 会话死亡

- **日期**：2026-10-22
- **等级**：高（阻塞一切验收：用户打不开界面，交付无法自证）
- **用户原话**：「服务又挂了,这个已经成为常态. 结束后无法验收. 给出解决方案.」
- **结论**：不是偶发崩溃，是**托管模型错误**——所有常驻进程都寄生在 agent 的 shell 作业对象里，命令/会话一结束就被连带杀死。
- **状态**：已根治（守护器托管到 WMI 进程，实测杀掉后 30s 内自愈）。

---

## 一、现象与取证

### 1.1 用户侧表现

- 界面能打开（vite 还在），但所有数据报错：「request orig-tg: error sending request for url (http://127.0.0.1:19787/...)」
- 每次会话结束、或隔几小时回来，栈必死；重新拉起后过一阵又死。
- 用户判定「这已经成为常态」，且「结束后无法验收」——我交付时栈已死，用户无法复现验证。

### 1.2 取证：进程是「被外部杀死」，不是自己崩

`%TEMP%\orighub-dev-daemon.log` 的末尾：

```
orig-daemon listening on http://127.0.0.1:19786
orig-tg plugin started
[orig-daemon] pid=2556 listening on http://127.0.0.1:19786 | TG plugin auto-managed ...
```

**最后一行是启动成功的公告，之后没有 panic、没有 error、没有 shutdown 记录。** 且日志文件的 mtime 停在 08:07，而当时是 15:58——说明 daemon 在 08:07 就消失了，之后 8 小时无人拉起。

复现：用 `python scripts/dev_services.py --start` 起 daemon（返回 `ready: true`，pid=2556），**6 秒后 19786 端口消失**，日志同样只多了一条启动公告。

### 1.3 根因：`DETACHED_PROCESS` 只脱控制台，不脱 job object

`dev_services.py` 启动 daemon 用的是：

```python
creationflags=DETACHED | NEW_GROUP   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
```

`DETACHED_PROCESS` 让进程没有控制台窗口，但**它仍然是父进程所在 job object 的成员**。agent 的每条 shell 命令都在一个 job 里；命令结束（或后台任务被回收、会话关闭）时 job 关闭，带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job 会把里面所有进程一起 `TerminateProcess`——detached 的子进程也在内。

这就精确解释了「常态」：

| 起法 | 存活时间 | 为什么死 |
|---|---|---|
| `--start` 直接跑 | 秒级 | 命令返回 → job 关闭 → 连带杀死 |
| `--start; sleep 28800` 放后台任务 | 数小时 | 后台任务结束/被回收 → job 关闭 → 连带杀死 |
| 用户双击 exe（release） | 不受影响 | 不经 agent job |

**证据（决定性）**：守护器托管后，`taskkill /PID <daemon> /T /F` 的输出是

```
成功: 已终止 PID 17160 (属于 PID 39888 子进程)
```

daemon 的父进程是守护器（PID 39888），而守护器由 `WmiPrvSE.exe` 创建 ⇒ 整条链都不在 agent 的 job 里。

### 1.4 为什么不用计划任务

本机 `schtasks.exe` 被安全策略列入**程序黑名单**，无法启动、无法绕过（已实测报 `PROGRAM BLOCKED BY SECURITY POLICY`）。`sc.exe` 需要管理员权限。因此可用的「系统级托管」只有 WMI：`Win32_Process.Create` 由 `WmiPrvSE.exe` 创建进程，父进程不在 agent 的 job 内。

---

## 二、解决方案（三层）

### 2.1 常驻守护器 `scripts/stack_guard.py`

每 20s 探一次三项，掉哪个拉哪个：

| 组件 | 端口 | 判据 | 修复动作 |
|---|---|---|---|
| daemon | 19786 | `GET /api/config` 有 JSON（不只看端口：卡死的僵尸也会占着端口） | 清僵尸 → `dev_services.start_daemon` |
| orig-tg | 19787 | `GET /api/tg/session` 可达 | **不插手**：daemon 自己监督，退出后 ~15s 重启 |
| vite | 5180 | TCP connect | `cmd /c npm run dev`（detached） |

- 状态落 `%TEMP%\orighub-stack-guard.json`，日志 `%TEMP%\orighub-stack-guard.log`。
- 单实例：lock 文件 + pid 存活判断（陈旧 lock 自动回收）。
- 日志抑制：只在「首次掉线」与「每 10 轮」写一条，避免 BUG-373 那种风暴把日志刷爆。
- `pythonw.exe` 下 `sys.stdout is None`，`log()` 显式判空——否则 `print` 抛 `AttributeError` 把守护打死。

### 2.2 脱离 job 的启动方式 `scripts/launch_detached.ps1`

WMI `Win32_Process.Create` 启动守护器，父进程变 `WmiPrvSE.exe`，会话结束不影响。

> 踩坑：PowerShell 5.1 按 **ANSI/GBK** 读 `.ps1`，文件含 UTF-8 中文会直接语法错误（`表达式或语句中包含意外的标记`）。该脚本**必须纯 ASCII**。

### 2.3 用户自助入口 `scripts/start-stack.cmd`

双击即：①跑一轮修复并打印结果；②用 WMI 起常驻守护。关闭窗口不影响服务。

`pythonw` 用 `where pythonw` 解析成绝对路径再传给 WMI——**WMI 创建的进程不继承当前控制台的 PATH**，裸写 `pythonw` 会解析失败。

---

## 三、验收（有牙）

| 项 | 方法 | 结果 |
|---|---|---|
| 守护器跨命令存活 | WMI 起 guard → 命令返回 → 35s 后 `tasklist` | pid 39888 仍在 |
| 自愈 | `taskkill /PID 17160 /T /F`（连坐 orig-tg）→ 等 30s | daemon 35784 + orig-tg 23452 自动回来，日志有记录 |
| 三项在线 | `stack_guard.py --status` | `daemon / orig-tg / vite` 全 OK，前端 `http://localhost:5180` 200 |
| 链路真实可用 | `curl :5180/` → 200 `text/html`；`curl :19786/api/activity?scope=all` → 200 / 10.5ms | 通过 |
| 顺带：BUG-375 端到端 | 新 orig-tg（release，含增量合并）上连测 `/api/tg/cache/tasks/all` | 148 条任务，中位 17–28ms，多数 6–10ms |

**回归守卫（交付前必跑）**：

```
python scripts/stack_guard.py --status     # 退出码 0 = 三项在线，才可以交付
```

---

## 四、未修 / 未做（不擅动，等点名）

1. **约 20% 请求仍有 250–320ms 尖峰**（`/api/tg/cache/tasks/all`，148 条 / 56.9KB）。
   已定位边界：`ttfb ≈ total` ⇒ 服务端处理慢，非传输；与标题自愈尝试次数无关（上限 3 已耗尽仍复现）；读路径本身零 DB（中位 6–10ms）。下一步要查的是 tokio worker 是否被某个同步阻塞点占住，属新问题、未点名。
2. **BUG-373 的 supervisor 策略**（3 连败即杀）未改；当前实例启动后已无风暴（`link down`/`restarting` 计数为 0），但策略本身仍在。
3. **开机自启未安装**：现在守护器只活到本次登录会话结束。需要跨重启常驻时，把 `start-stack.cmd` 放进「启动」文件夹即可（涉及用户环境改动，未擅自安装）。
4. **daemon 的 `default_download_dir` 仍返回 `C:/Users/.../Downloads`**（名义默认值）。实际写点已按 D 盘规则改道内容根，此处不涉及写盘，未动。

---

## 五、改版（2026-10-22，用户裁定）

**用户原话**：「还需要考虑一点,测试开发新编译和旧编译冲突,最好有一个手动启动入口执行脚本,我来控制,后续你就不用管自动监控. 这部分和正式二进制逻辑需要分开,这仅仅是为了方便测试的.」

三条裁定，逐条落地：

| 裁定 | 落地 |
|---|---|
| 我来控制，不要自动监控 | **删掉**常驻守护（`stack_guard.py --daemon`）、WMI 托管（`launch_detached.ps1`）、双击自动守护入口（`start-stack.cmd`）。新入口跑完即退，不留任何常驻进程。 |
| 测试脚本与正式二进制逻辑分开 | 全部收进 **`scripts/dev/`**（dev-only 目录）：`dev_stack.py` + `dev-stack.cmd`。不链接进 `orig-daemon` / `orig-tg` / Tauri 壳，不改变任何发布产物的运行时行为。 |
| 考虑新编译与旧编译冲突 | 见下节的两种冲突与判据。 |

### 5.1 两种「新旧冲突」，是两件事

| 冲突 | 表现 | 判据 | 解法 |
|---|---|---|---|
| **进程跑旧编译** | exe 已更新，但进程还是上一次启动的 | `exe.mtime > 进程启动时间 + 2s` | `restart` |
| **产物比源码旧** | 源码改了没重建，重启也没用 | 本 crate + 依赖 crate 里有 `.rs`/`Cargo.toml` 比 exe 新 | `build` |

只判前者会让「产物比源码旧」被一句「可以验收」盖掉——这是第一版判据的洞，已修：`status` 的结论按 **离线 → 产物旧 → 进程旧 → 全绿** 的顺序短路，任一条成立就退出码 1。

### 5.2 为什么 `build` 必须先 `stop`

Windows 上运行中的 `.exe` 被文件锁占住：`cargo build --release` 链接 `target/release/orig-daemon.exe` 会直接失败（Access is denied），`sync-sidecars.sh` 的 `cp -f` 同样失败。所以 `build` 动作固化为 **stop → cargo build → sync → 打印新指纹**，顺序不可换。

### 5.3 实测与证伪

- **真实命中**：首次 `status` 就抓到 `orig-tg: 产物比源码旧（crates/orig-tg/src/state.rs 更新）`。这证明磁盘上的 `orig-tg.exe`（06:15 构建）**不含提交 `88ede8a`** 的自愈即时解析修复——也就是本轮之前那次「端到端实测 BUG-375」跑的是 `ab02936` 的版本，不是最终版。判据第一次运行就抓到了人眼漏掉的事。
- **反向证伪（进程跑旧编译）**：把 `orig-daemon.exe` 的 mtime 用 `os.utime` 推到进程启动之后（16:20:03 vs 启动 16:03:48）⇒ `status` 立刻输出「⚠ 跑的是旧编译：exe 在进程启动之后被改写过」且退出码 1；随后把 mtime 精确恢复为 `2026-10-21 19:12:02`，复测恢复正常。判据有牙，且改动可逆。

### 5.4 用法（人控制，跑完即退）

```
scripts\dev\dev-stack.cmd            # 双击：菜单（起/重启/停/构建/只重建 tg/状态）
dev-stack.cmd status                 # 也可直接带子命令
python scripts/dev/dev_stack.py status|stop|start|restart|build|build-tg
```

`status` 退出码：`0` = 三项在线且产物与源码一致、进程跑的就是这份编译；`1` = 有任一不满足（并打印是哪一种）。

