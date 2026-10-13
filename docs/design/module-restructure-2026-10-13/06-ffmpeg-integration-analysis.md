# ffmpeg 集成方式分析：编译二进制 · 接口化调用 · 能力支持 · 性能与可行性对比

- 日期：2026-10-13
- 用户裁定前提：**使用独立编译/构建的 ffmpeg 二进制；应用只通过接口（子进程命令行 + stdout/stderr/SSE）使用，不链接 libav、不内嵌 ffmpeg**。
- 配套：[04-api-contracts.md](04-api-contracts.md) §1/§5、[07-playback-performance-contract.md](07-playback-performance-contract.md)（播放零损失）、spec §7

---

## 快速概览（TL;DR）

| 问题 | 结论 |
|---|---|
| 怎么集成 | **外部二进制 + 子进程接口**（现状路线的正规化）：不引入 libav FFI；所有调用经统一 `Ffmpeg` 服务模块生成参数、spawn、解析输出；播放器与 UI 只接触应用自己的 HTTP 契约，永不见 ffmpeg |
| 二进制从哪来 | **官方静态构建受管下载 + sha256 钉死 + 三种安装路径**（在线/手动/离线）；不自建编译链（收益低、供应链与维护成本高），见 §3 |
| 调用形态 | **按需子进程（per-session），不做常驻 ffmpeg 服务**：二进制本身就是「服务」——由 orig-daemon 的 ffmpeg 模块统一托管进程生命周期；Windows 下常驻方案无收益且更脆，见 §4 |
| 性能最佳解 | **不转码才是最快**：原生直出 > 容器重封装（-c copy，CPU 近零）> GPU 硬解（NVDEC/QSV/D3D11VA）+ 必要时硬编 > 纯软解兜底。转码是最后手段且必须在播放关键路径之外可观测 |
| 硬解选型 | Windows 优先级：**NVIDIA NVDEC/CUVID → Intel/AMD QSV → D3D11VA 通用兜底**；ffmpeg_caps 自动探测已具备，M1 暴露给用户可设；详见 §5 |
| 可行性最高 | 官方 gyan.dev/BtbN 静态构建已内置全部硬解/编码支持，运行时只需显卡驱动；M4 安装器 + 校验即可闭环，无原生编译环境要求 |

---

## 1. 现状盘点（取证）

| 项 | 现状 |
|---|---|
| 调用方式 | 唯一转码 spawn 点 = transcode pump（`orig-tg/src/routes.rs` 约 L4634 起）；按需起、随会话结束而退；L4721 注入 `cfg.input_args()` |
| 能力探测 | `orig-tg/src/ffmpeg_caps.rs`：纯函数探测 hwaccels/decoders、GPU 枚举、推荐配置；进程级 `OnceCell` 缓存（routes.rs L4411） |
| 用户可设性 | 无 UI/无持久化；仅环境变量 `ORIG_TG_HWACCEL=off` 与 `ORIG_FFMPEG_PATH` |
| 解析链 | env → sidecar 同目录 → TG data/bin → `%LOCALAPPDATA%\OrigHub\bin` → PATH |
| 缺失行为 | stream 端点 501；无 ffprobe 产品化调用 |
| 播放关系 | raw 直出不碰 ffmpeg；仅 stream（浏览器不兼容源）走转码泵 |

结论：**架构方向本来就对（外部二进制 + 按需子进程）**，缺的是：分发受管、接口收敛（调用点散落 pump 内）、能力/配置可观测可设置。

---

## 2. 集成形态对比：外部二进制 vs 链接库 vs 常驻服务

| 方案 | 描述 | 性能 | 可行性/成本 | 风险 |
|---|---|---|---|---|
| **A. 外部二进制 + 子进程（选定）** | spawn ffmpeg.exe，stdin/stdout/管道/文件交互；应用与 ffmpeg 许可证隔离（仅进程调用，不构成衍生作品）；崩溃不拖垮宿主 | 进程启动开销一次/会话（百毫秒级）；编解码性能 = ffmpeg 原生，无 FFI 拷贝层 | **最高**：现状已验证；无构建链；版本可独立替换 | 参数注入/路径安全（经统一接口层收敛，禁止拼字符串） |
| B. 链接 libav（Rust binding/FFI） | 进程内调用 libavcodec | 理论上省进程启动与一次拷贝 | **低**：需自行解决 LGPL 动态链接合规或 GPL 全项目传染；Windows 构建链复杂；升级跟随绑定版本 | 许可证污染闭源壳；native panic 跨 FFI = 进程崩溃；与用户裁定冲突 |
| C. 常驻 ffmpeg 服务进程 | 自写包装服务，ffmpeg 长期驻留接受任务 | 省冷启动（~100-300ms，仅每次播放一次） | 中：要设计任务协议、队列、僵尸进程/句柄泄漏治理、版本一致 | ffmpeg CLI 本就不是服务；stdin 长会话稳定性差；多任务隔离难；多出一个需要被托管/拉起/重启的进程（正是本项目在 BUG-172 踩过的坑） |
| D. HTTP 媒体引擎（额外第三方服务） | 引入 Jellyfin/ffmpeg-server 类组件 | 多一跳本地 HTTP | 低：体积、端口、鉴权、版本全失控 | 违反「不新增 sidecar」方向 |

**选型：A。** 「使用服务」的落地语义 = **orig-daemon 内的 `modules/ffmpeg` 服务模块**（对 UI/播放器提供稳定 HTTP 契约，对下统一管二进制），而不是让 ffmpeg 自己常驻。

接口分层（全部代码只允许依赖下层接口，不允许直接 spawn）：

```
UI（设置·播放引擎 / 播放器 501 引导）
  └─ HTTP: /api/ffmpeg/{status,config,install/*}        ← 对前端的稳定契约（04 文档）
       modules/ffmpeg/service.rs                        ← 应用内服务：有效配置、能力缓存、作业状态
          ├─ caps.rs（探测，现 ffmpeg_caps.rs 迁入）
          ├─ installer.rs（M4：计划/下载/校验/落盘/SSE）
          └─ cli.rs（唯一 spawn 点：参数结构化构造、超时、取消、输出解析）
               transcode pump（播放路径调用 cli，不自己拼参数）
```

---

## 3. 二进制分发方案对比（2026-10 事实）

外部生态事实（2026-10-13 核实）：ffmpeg 最新稳定 **9.0.2（2026-09-18）**；Windows 官方入口仅两家：**gyan.dev**（全部 64 位静态构建，GPLv3；release-full 另有 shared+dev 包）与 **BtbN**（master/release 自动构建，提供 gpl 与 lgpl 两套 zip）。两类构建**均已内置** NVENC/NVDEC、QSV、AMF 等硬解硬编支持——运行时只需显卡驱动，无需随包分发 NVIDIA SDK。

| 方案 | 描述 | 性能 | 可行性 | 供应链/许可 | 评分 |
|---|---|---|---|---|---|
| **A. 官方静态构建受管下载（选定）** | 安装器从钉死 URL 取 gyan/BtbN release-essentials/full 静态包，sha256 校验落 `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe` | 与自编译同档（官方开了全部主流硬解/优化编译选项） | **高**：无需编译环境；解压即用；在线/手动/离线三路径 | 中：需钉版本+哈希+清单签名信任根（M4 安全评审）；GPLv3 与「仅进程调用」兼容（不链接、不修改、独立目录、About 页声明来源与许可证） | ★★★★★ |
| B. 自建编译链产出二进制 | CI 用 mxe/msys2 编译，裁剪 codec、开特定优化 | 理论上可裁包体/开 `-march=native`（桌面分发 `-march=native` 反而是坑：跨 CPU 崩溃） | **低**：维护工具链、补丁跟进、构建机成本高；收益实测通常 <5% | 供应链自控最强；GPL 义务依旧 | ★★ |
| C. 仅用系统 PATH | 让用户自己装 | — | 高但体验差；版本不可控（4.x 老版本参数差异） | 501 高发起率；违背 D2=A 受管裁定 | ★★ |
| D. 随安装包捆绑 | 首次安装即带 | 最好（零下载） | 中：安装包体积 +60-100MB；跨平台包多份 | 升级 ffmpeg 要发版应用；仍需哈希；代理环境无所谓但离线版巨大 | ★★★（可作为 A 的未来补充，不做首发） |

**关于 GPLv3**：独立二进制 + 子进程调用 + 不修改不分发到同一可执行文件内，是 ffmpeg 官方与社区长期通行的合规用法；义务集中在「保留许可声明、提供来源说明」。About 区块加「ffmpeg 来源/许可证/版本」声明即可（纳入 M4 AC）。LGPL 构建（BtbN lgpl 或 gyan shared）少 GPL 组件（如 x264/x265 在 essentials 中的取舍需逐版本核对），若后续要 H.264/H.265 软件编码兜底，**full-gpl 包能力更全**，许可上进程隔离同样成立。M4 清单评审时定稿取包变体。

**清单与信任根（M4 设计约束）**：

1. 应用内置「已知良好版本清单」：版本号、URL、sha256（随应用版本发，不现场抓「最新」）；
2. 可选增强：清单 detached 签名（信任根 = 应用公钥），防止发布源被篡改后静默换包；
3. 下载走 daemon 代理配置（127.0.0.1:7897 等）；
4. 三路径：在线下载 / 手动选择本机 exe（同样 `ffmpeg -version` 回读 + 能力探测，不强求哈希）/ 离线包目录（哈希必校）；
5. 安装 = 下载临时文件 → 哈希校验 → 解压 staging → `-version` 探针 → 原子 rename；任一步失败旧版本不动。

---

## 4. 调用接口与并发模型

### 4.1 统一 CLI 接口（`modules/ffmpeg/cli.rs`）

- 参数以**结构化类型**构造（`TranscodeSpec { input, range, target:{container,vcodec,acodec}, hw:{mode,device}, out }`），集中映射为 argv；禁止在业务代码字符串拼接（命令注入面）。
- 每次调用：明确超时/取消令牌（沿用 ELT-T01 已修的取消守卫模式）、stderr 行解析为结构化日志、退出码映射错误类型。
- 能力探测（重）进程级缓存；**用户配置不缓存进 OnceCell**：每次作业读有效配置（env > persisted > auto），M1 AC 已覆盖「auto→off 无需重启即生效」。

### 4.2 并发与资源

| 场景 | 策略 |
|---|---|
| 单个播放会话 | 1 个 ffmpeg 子进程，随客户端断开/seek 取消而终止；转码输出走现有 pump 的 FRC 节流/32MiB 块纪律（07 文档） |
| 多客户端/多视频 | v1 **不允许同机多转码并发**（桌面单机单用户，第二个会话排队或提示）；M4 后评估信号量（默认 1，硬解空闲可 2），防止 GPU/CPU 打满拖垮正在看的那个——**流畅优先于并发数** |
| 后台预转码（若 D6 选 B） | 独立低优先级作业队列，限速（nice/低线程数），**播放器会话永远插队优先**，且与播放共用同一 cli/预算模块 |
| GPU 选择 | 多显卡按 gpus 列表 + 用户覆盖；默认推荐主独显（caps 已实现推荐逻辑） |

### 4.3 探测内容（status 契约返回，UI 直接消费）

- `-version`、`-hwaccels`、`-decoders/-encoders`（NVDEC/CUVID/QSV/D3D11VA/DXVA2/AMF）、关键滤镜；
- GPU 枚举（厂商/索引/名称）；推荐三元组（hwaccel/device/解码族支持表）；
- 解析链每步命中（排障用）；env 覆盖回显。

---

## 5. 硬解能力与性能对比（Windows 桌面）

数据来源：ffmpeg 官方 HWAccelIntro、NVIDIA Video Codec SDK NVDEC Application Note（2026 现行 13.x）、公开对比测试；本机实际以 caps 探测为准。

### 5.1 后端对比

| 后端 | 厂商 | 机制 | 解码性能 | 编码 | 适用 | 坑 |
|---|---|---|---|---|---|---|
| **NVDEC（含 h264/hevc_cuvid）** | NVIDIA | GPU 独立解码固定功能单元，解码与 3D/计算并行不抢 CUDA 核 | 4K/8K H.264/HEVC/AV1 高倍速，CPU 占用接近 0 | NVENC 配套，端到端转码极快 | 驱动门槛；个别冷门码流回退少；消费卡并发路数历史限制（桌面场景=1 路，无影响） |
| **QSV（Intel 核显 / 含 Arc；AMD 新 APU 部分）** | Intel | 显固定功能 + 视频内存 | 与 NVDEC 同档，笔记本 Intel 平台首选 | QSV 编码质量好、低功耗 | 多显卡笔记本需选对 device；驱动版本敏感 |
| **D3D11VA** | 微软通用 | DX11 设备，厂商驱动实现 | 良好、延迟优于 DXVA2；**兼容性很广** | 无对应通用编码器（编码仍走各厂商） | 最佳「通用兜底」，Win10+ 全覆盖 |
| DXVA2 | 微软旧 | DX9 时代接口 | 一般、拷贝开销大 | 无 | 稳定性极高、兼容极广；仅在 D3D11VA 失败时兜底 |
| 纯软解（libavcodec CPU） | — | 多线程 | 1080p 尚可、4K HEVC 高码率吃紧；耗电极高 | x264/x265（GPL 包） | 永远可用的最后防线；ffmpeg_caps 已实现软解 fallback |
| AMF | AMD 独显 | 主要编码 | 解码支持面窄于 D3D11VA | AMD 编码 | 播放场景解码优先走 D3D11VA 即可 |

### 5.2 播放场景的关键结论（与 07 文档一致）

1. **硬解只在「必须转码」时才有讨论意义**；浏览器原生能播的源直出，ffmpeg 完全不启动（零开销 > 任何硬解）。
2. 需要转码时，解码端硬解收益最大（HEVC 4K 软解是实时性瓶颈，硬解把 CPU 占用从数十甚至上百百分点压到个位数）；**编码端**若也要转（如 HEVC→H.264），NVENC/QSV 同步硬编才构成完整低占用链路。
3. 选型顺序：caps 探测 → 有 NVIDIA 用 NVDEC/CUVID；Intel 平台用 QSV；否则 D3D11VA；全失败软解 + 在 UI 明示。现状 `probe_config` 已是这个思路，M1 把它「可设置 + 可见」即可。
4. 重封装（`-c copy` 解封装/再封装，不碰编解码）CPU 近零，是「容器不兼容但编码兼容」（如 MKV HEVC → fMP4，浏览器支持 HEVC 时）的首选档；成本仅在 muxer，需在 D6 策略中置于转码之前。

### 5.3 度量口径（M1/M4 验收指标，具体阈值在 dev-plan 按基线机标定）

- 冷启动到首字节：`ffmpeg -version` 探针 < 300ms（参考级，实测标定）；
- 转码起播：从请求到 ffmpeg 首包（与现状 pump 持平，不得回退）；
- 硬解收益：同一片源，硬解 vs 软解的 CPU% 与掉帧率（rVFC `droppedVideoFrames`）对比截图/日志；
- 功耗/发热：笔记本电池模式下软解/硬解功耗差（可选）。

---

## 6. 与现有任务/缺陷的映射

| 项 | 落点 |
|---|---|
| PD-T01 可诊断 / PD-T06 硬解默认+多显卡+推荐 | M1（诊断端点 + 设置区 + 即时生效） |
| PD-T03 受管安装（D2=A） | M4（§3 方案 A，清单+哈希+三路径+许可声明） |
| ELT-T05/06（ffmpeg 可设置缺失、OnceCell 不可改） | M1 关闭 |
| BUG-208/230 stream-first、501 | M1 文案可行动化；播放策略见 07 文档/D6 |
| 迁移 | M3：caps/service/cli 随媒体路由迁入 orig-daemon；M1 在 orig-tg 先行不白做（模块原样平移） |

---

## 7. 风险与纪律

1. 唯一 spawn 点纪律：除安装器的短命令探针外，业务代码只调 `modules/ffmpeg/cli.rs`；M3 代码评审 grep 把关。
2. 安全：argv 结构化、路径校验（禁止用户参数直通任意 flag，manual 模式只开放枚举值 + 路径选择）；ffmpeg.exe 落盘目录防劫持（用户目录 + 原子替换）。
3. 许可：About 声明 GPLv3 静态构建来源与「独立进程调用」事实；不修改二进制。
4. 版本钉死：应用永远先认内置清单，不自动追最新；升级走应用版本。
5. 失败优雅：探测失败软解兜底（现状已有）；安装失败旧版不动；转码失败播放器回退提示而非白屏（decodeHealth 联动）。
