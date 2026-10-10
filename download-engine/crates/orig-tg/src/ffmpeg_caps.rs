//! ffmpeg 硬件解码能力探测与**推荐配置生成**（PD-T06）。
//!
//! 设计真源：`docs/design/product-direction-and-ffmpeg-2026-10-09.md` §2.5
//! （2026-10-10 用户指令追加节：2.5.1 现状 / 2.5.2 实测依据 / 2.5.4 设计 /
//! 2.5.5 能力边界 / 2.5.6 多显卡）。缺陷档：`docs/bugs/BUG-237.md`。
//!
//! ## 本模块只做两件事
//!
//! 1. **静态能力探测**：把 `ffmpeg -hwaccels` / `ffmpeg -encoders` / `nvidia-smi -L` /
//!    WMI `Win32_VideoController` 的**输出文本**解析成结构化结果（[`Caps`]）；
//! 2. **推荐配置**：按 §2.5.4 ② 的保守默认决策表产出 [`FfmpegConfig`]。
//!
//! ## 设计原则：纯函数优先
//!
//! 所有解析函数都是「文本进、结构化结果出」的**纯函数** —— **不启进程、不读环境变量、
//! 不碰 IO**。因此每条规则都能单测，且**机器上不必真装 ffmpeg**。
//! 「真正去跑命令」「缓存探测结果」「接线进 `routes.rs::run_transcode` 的参数构造处」
//! 属于后续任务，**不在本文件范围内**。
//!
//! ## ★ 能力边界（§2.5.5：不许把「配置估算」说成「性能预测」）
//!
//! 本模块只回答**静态可得的布尔与枚举**：**能不能**硬解、支持**哪些**后端、
//! 有**哪些** GPU、有没有硬件编码器。
//!
//! 它**不预测吞吐、不预测能跑几倍速** —— 同机同档位不同内容实测相差约 **5 倍**
//! （720p H.264 16.6x vs 1080p HEVC 3.5x，见 §2.5.5），差异来自**内容**，不来自配置。
//! 要真实数字那是**基准**（BUG-226 的 `-t 60` 采样方法），**不属于配置**。
//!
//! ⇒ 「推荐配置」是**保守默认 + 可回退 + 可覆盖**，**不是**「算出能跑几倍速」。
//!
//! ## 只做硬解，不做别的（§2.5.2 实测，条目 673 / HEVC 1080p / `-t 60` 串行采样）
//!
//! - ✅ **只做硬解**：4x 档纯软解软编 3.37–3.59x（全片 4.12x），加 `-hwaccel` 后 **6.76x**，
//!   零画质代价 —— 唯一有效手段。
//! - ❌ **不做分辨率切换 / 不做「自动最佳分辨率」**：降 720p 单独 3.97x、叠加硬解 6.82x，
//!   **降分辨率无增益**，做自适应是白做工。
//! - ❌ **硬件编码默认关**：nvenc 驱动不足 / qsv 慢于软编 / amf 无卡 ⇒ 实测不可用。
//!   硬件编码器仅作**可选项**保留（[`FfmpegConfig::hw_encode`] 恒为 `false`），
//!   默认仍走软编 `libx264`。
//!
//! ## 多显卡与 `auto`（§2.5.6）
//!
//! 多显卡机器上 `-hwaccel auto` 的选择**不由我们决定**（本机实测选中 `dxva2`，未必是独显）
//! ⇒ **不能靠 `auto` 兑现「多显卡感知」**，必须显式指定后端与设备。
//!
//! 因此 [`HwAccel`] **故意不设 `Auto` 变体** —— 用类型系统让「返回 auto」**不可表达**：
//! 推荐链路里根本构造不出 `auto`，[`HwAccel::from_name`] 对 `"auto"` 也返回 `None`。
//!
//! ## 与 `encode_profile` 的职责边界
//!
//! [`FfmpegConfig::input_args`] **只产出输入侧参数**（`-hwaccel` / `-hwaccel_device`）。
//! preset / crf / fps / `-vf` / `-af` 等档位参数**仍归 `encode_profile` 独管**，本模块**不碰**。

use std::fmt;

/// `ffmpeg -hwaccels` 输出的标题行前缀。
const HWACCELS_TITLE_PREFIX: &str = "hardware acceleration methods";

/// `ffmpeg -encoders` 行首标志位允许的字符集（6 位，缺位用 `.` 填充）。
///
/// 例：` V....D h264_nvenc` 的首字段 `V....D`：V=Video、D=支持 direct rendering。
const ENCODER_FLAG_CHARS: &[char] = &['V', 'A', 'S', 'F', 'X', 'B', 'D', '.'];

/// 硬件编码器名的后缀白名单（用于从 `ffmpeg -encoders` 全量列表里区分硬件编码器）。
///
/// 覆盖 §2.5.4 ① 关心的三大家（nvenc / qsv / amf）以及其它平台的常见硬件编码器，
/// 便于 diag 如实展示。
const HW_ENCODER_SUFFIXES: &[&str] = &[
    "_nvenc",
    "_qsv",
    "_amf",
    "_vaapi",
    "_videotoolbox",
    "_v4l2m2m",
    "_mediacodec",
    "_mf",
];

/// GPU 厂商。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vendor {
    /// NVIDIA（`nvidia-smi -L` 或名字含 `nvidia`）。
    Nvidia,
    /// AMD（名字含 `amd` 或 `radeon`）。
    Amd,
    /// Intel（核显为主）。
    Intel,
    /// 无法判定（如 `Microsoft Basic Display Adapter`）。
    Unknown,
}

impl Vendor {
    /// 从 GPU 名字推断厂商（大小写不敏感）。
    pub fn from_name(name: &str) -> Self {
        let lower = name.to_lowercase();
        if lower.contains("nvidia") {
            Vendor::Nvidia
        } else if lower.contains("amd") || lower.contains("radeon") {
            Vendor::Amd
        } else if lower.contains("intel") {
            Vendor::Intel
        } else {
            Vendor::Unknown
        }
    }

    /// 稳定标识，供日志 / diag 输出使用。
    pub fn as_str(&self) -> &'static str {
        match self {
            Vendor::Nvidia => "nvidia",
            Vendor::Amd => "amd",
            Vendor::Intel => "intel",
            Vendor::Unknown => "unknown",
        }
    }
}

impl fmt::Display for Vendor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 一张显卡。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gpu {
    /// 显卡名（`nvidia-smi -L` 去掉序号与 UUID；WMI 取 `Name` 列原值）。
    pub name: String,
    /// 厂商。
    pub vendor: Vendor,
    /// 是否为**独显**。判定规则见 [`is_dedicated_name`]。
    pub dedicated: bool,
    /// 显存字节数；WMI `AdapterRAM` 缺失或不可解析时为 `None`。
    ///
    /// 注：`nvidia-smi -L` 不输出显存 ⇒ 该来源的条目恒为 `None`。
    pub memory_bytes: Option<u64>,
}

/// 解析 `ffmpeg -hwaccels` 的标准输出，返回**可用硬解后端名**（统一小写、已去重）。
///
/// 真实输出形如（首行为标题，之前可能夹带版本 banner）：
///
/// ```text
/// ffmpeg version 6.0 ...
/// Hardware acceleration methods:
/// cuda
/// vaapi
/// dxva2
/// qsv
/// d3d11va
/// d3d12va
/// amf
/// ```
///
/// 规则：标题行**及其之前**的内容一律跳过；其后逐行 trim、去空行、忽略大小写去重。
/// 只有标题行或输入为空 ⇒ 返回空 `Vec`。
pub fn parse_hwaccels(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen_title = false;

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if !seen_title {
            if line.to_lowercase().starts_with(HWACCELS_TITLE_PREFIX) {
                seen_title = true;
            }
            continue; // banner 与标题行本身都不算后端
        }
        let name = line.to_lowercase();
        if !out.iter().any(|existing| existing == &name) {
            out.push(name);
        }
    }

    out
}

/// 解析 `ffmpeg -encoders` 的标准输出，返回**编码器名**列表（按出现顺序，已去重）。
///
/// 数据行形如 ` V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)`：
/// 首字段是 6 位标志位，第二个字段是编码器名。表头、`------` 分隔线、
/// ` V..... = Video` 这类图例行会被**结构性排除**（首字段不是合法的 6 位标志位）。
///
/// 本函数返回**全量**编码器（含 `libx264` 等软编）；只要硬件编码器时用
/// [`hardware_encoders`] 过滤。
pub fn parse_encoders(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for raw_line in stdout.lines() {
        let mut fields = raw_line.split_whitespace();
        let Some(flags) = fields.next() else {
            continue; // 空行
        };
        if !is_encoder_flag_field(flags) {
            continue; // 表头 / 分隔线 / 图例行
        }
        let Some(name) = fields.next() else {
            continue; // 有标志位却没名字：异常行，跳过
        };
        if !is_encoder_name(name) {
            continue; // 图例行（` V..... = Video`：第二个字段是 `=`）
        }
        if !out.iter().any(|existing| existing == name) {
            out.push(name.to_string());
        }
    }

    out
}

/// 从编码器名列表里筛出**硬件编码器**（后缀匹配 [`HW_ENCODER_SUFFIXES`]）。
///
/// 例：`["libx264", "h264_nvenc", "h264_qsv", "h264_amf"]` ⇒ `["h264_nvenc", "h264_qsv", "h264_amf"]`。
/// 没有任何硬件编码器 ⇒ 空 `Vec`。
pub fn hardware_encoders(encoders: &[String]) -> Vec<String> {
    encoders
        .iter()
        .filter(|name| is_hardware_encoder(name))
        .cloned()
        .collect()
}

/// 判断某行首字段是否为合法的 6 位编码器标志位。
fn is_encoder_flag_field(field: &str) -> bool {
    if field.chars().count() != 6 {
        return false;
    }
    let mut chars = field.chars();
    match chars.next() {
        // 类型位必须是视频 / 音频 / 字幕之一
        Some('V') | Some('A') | Some('S') => {}
        _ => return false,
    }
    chars.all(|c| ENCODER_FLAG_CHARS.contains(&c))
}

/// 判断第二个字段是否为合法的编码器名（只含 ASCII 字母数字与 `_` `-` `.`）。
///
/// 这一条把 ` V..... = Video` 这类**图例行**排除掉：它们的首字段同样是合法的 6 位标志位，
/// 但第二个字段是 `=`。
fn is_encoder_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// 判断编码器名是否为硬件编码器（大小写不敏感的后缀匹配）。
fn is_hardware_encoder(name: &str) -> bool {
    let lower = name.to_lowercase();
    HW_ENCODER_SUFFIXES
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

/// 解析 `nvidia-smi -L` 与 WMI `Win32_VideoController` CSV 的输出，返回去重后的 GPU 列表。
///
/// - `nvidia_smi`：`GPU 0: NVIDIA GeForce RTX 3060 Laptop GPU (UUID: GPU-xxxx)` 每行一张卡；
///   非 `GPU <n>:` 开头的行（如 `No devices were found`）被忽略。
/// - `wmi_csv`：首行为列名，按**列名**定位 `Name` 与 `AdapterRAM`（字节数字符串），
///   **不硬编码列号**；引号内的逗号按 CSV 规则处理。
/// - **去重**：同名（忽略大小写）只保留一条，**`nvidia-smi` 的优先**
///   （WMI 的同名条目被丢弃，字段不合并 —— 见 `Gpu::memory_bytes` 注释）。
/// - 两个来源都为 `None` ⇒ 空 `Vec`（「不知道有什么 GPU」是诚实的结果）。
pub fn parse_gpu_list(nvidia_smi: Option<&str>, wmi_csv: Option<&str>) -> Vec<Gpu> {
    let mut gpus: Vec<Gpu> = Vec::new();

    if let Some(output) = nvidia_smi {
        for raw_line in output.lines() {
            let line = raw_line.trim();
            let Some(name) = parse_nvidia_smi_line(line) else {
                continue;
            };
            push_gpu_dedup(&mut gpus, Gpu::new(name, None));
        }
    }

    if let Some(csv) = wmi_csv {
        let mut name_idx: Option<usize> = None;
        let mut ram_idx: Option<usize> = None;
        let mut header_seen = false;

        for raw_line in csv.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let fields = split_csv_line(line);
            if !header_seen {
                // 首行是列名：按名字定位，列序变化不影响解析
                for (idx, column) in fields.iter().enumerate() {
                    let column = column.trim().to_lowercase();
                    if column == "name" {
                        name_idx = Some(idx);
                    } else if column == "adapterram" {
                        ram_idx = Some(idx);
                    }
                }
                header_seen = true;
                continue;
            }
            let Some(name) = name_idx.and_then(|idx| fields.get(idx)).map(|s| s.trim()) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            let memory_bytes = ram_idx
                .and_then(|idx| fields.get(idx))
                .map(|s| s.trim())
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|bytes| *bytes > 0);
            push_gpu_dedup(&mut gpus, Gpu::new(name.to_string(), memory_bytes));
        }
    }

    gpus
}

impl Gpu {
    /// 由名字（+ 可选显存）构造：厂商与独显判定都从名字推导，保持单一入口。
    fn new(name: String, memory_bytes: Option<u64>) -> Self {
        let vendor = Vendor::from_name(&name);
        let dedicated = is_dedicated_name(vendor, &name);
        Gpu {
            name,
            vendor,
            dedicated,
            memory_bytes,
        }
    }
}

/// 追加一张 GPU；同名（忽略大小写）已存在则**保留先到的**（`nvidia-smi` 优先）。
fn push_gpu_dedup(gpus: &mut Vec<Gpu>, gpu: Gpu) {
    let exists = gpus
        .iter()
        .any(|existing| existing.name.eq_ignore_ascii_case(&gpu.name));
    if !exists {
        gpus.push(gpu);
    }
}

/// 从 `nvidia-smi -L` 的一行里取出显卡名（去掉 `GPU 0:` 前缀与 `(UUID: ...)` 尾缀）。
fn parse_nvidia_smi_line(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if !lower.starts_with("gpu") {
        return None;
    }
    let colon = line.find(':')?;
    let mut name = line[colon + 1..].trim().to_string();
    if let Some(uuid_at) = name.to_lowercase().find("(uuid:") {
        name = name[..uuid_at].trim_end().to_string();
    }
    if name.is_empty() {
        return None;
    }
    Some(name)
}

/// 按 CSV 规则切分一行（支持 `"..."` 引号内逗号与 `""` 转义）。
fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => fields.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    fields.push(current);

    fields
}

/// 独显判定（§2.5.4 ②：只有 NVIDIA / AMD 的独显才值得显式指定后端与设备）。
///
/// - NVIDIA / AMD 且名字匹配 `GeForce` / `RTX` / `Radeon RX` / `Radeon(TM) RX` ⇒ `true`；
/// - Intel 一律 `false`（核显）；
/// - 厂商未知 ⇒ `false`。
fn is_dedicated_name(vendor: Vendor, name: &str) -> bool {
    if !matches!(vendor, Vendor::Nvidia | Vendor::Amd) {
        return false;
    }
    let lower = name.to_lowercase();
    lower.contains("geforce")
        || lower.contains("rtx")
        || lower.contains("radeon rx")
        || lower.contains("radeon(tm) rx")
}

/// 可用的**硬解后端**。
///
/// ★ **故意不设 `Auto` 变体**（§2.5.6）：多显卡机器上 `-hwaccel auto` 的选择不由我们决定
/// （本机实测选中 `dxva2`，未必是独显），因此用类型系统让「返回 auto」**不可表达**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwAccel {
    /// NVIDIA CUDA / NVDEC。
    Cuda,
    /// Direct3D 11（Windows 上比 dxva2 新，核显首选）。
    D3d11va,
    /// DirectX VA 2.0（旧 Windows 路径，兜底）。
    Dxva2,
    /// Intel Quick Sync Video。
    Qsv,
    /// Linux VA-API。
    Vaapi,
    /// AMD AMF / Direct3D 12。
    Amf,
    /// Direct3D 12 VA。
    D3d12va,
}

impl HwAccel {
    /// 由后端名构造（大小写不敏感）。
    ///
    /// `"auto"` **不在**合法集合内 ⇒ 返回 `None`（见本枚举的文档）。
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_lowercase().as_str() {
            "cuda" => Some(HwAccel::Cuda),
            "d3d11va" => Some(HwAccel::D3d11va),
            "dxva2" => Some(HwAccel::Dxva2),
            "qsv" => Some(HwAccel::Qsv),
            "vaapi" => Some(HwAccel::Vaapi),
            "amf" => Some(HwAccel::Amf),
            "d3d12va" => Some(HwAccel::D3d12va),
            _ => None,
        }
    }

    /// 传给 ffmpeg 的字面量（`-hwaccel <as_str>`）。
    pub fn as_str(&self) -> &'static str {
        match self {
            HwAccel::Cuda => "cuda",
            HwAccel::D3d11va => "d3d11va",
            HwAccel::Dxva2 => "dxva2",
            HwAccel::Qsv => "qsv",
            HwAccel::Vaapi => "vaapi",
            HwAccel::Amf => "amf",
            HwAccel::D3d12va => "d3d12va",
        }
    }
}

impl fmt::Display for HwAccel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// ffmpeg 的**输入侧**配置（硬解如何启用）。
///
/// ★ 只描述**输入侧**：preset / crf / fps / `-vf` / `-af` 仍归 `encode_profile` 独管，
/// 本结构**不得**越界（§2.5.4 ③「其余参数不变」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegConfig {
    /// 硬解后端；`None` ⇒ 软解（现状行为）。
    pub hwaccel: Option<HwAccel>,
    /// 显式设备（`-hwaccel_device`）；`None` ⇒ 不指定，让后端自己挑默认设备。
    pub device: Option<String>,
    /// 是否启用**硬件编码**。
    ///
    /// ★ 恒为 `false`（§2.5.4 ②）：本机实测 nvenc 驱动不足 / qsv 慢于软编 / amf 无卡，
    /// 硬件编码仅作**可选项**提供，**默认软编 `libx264`**。
    pub hw_encode: bool,
}

impl FfmpegConfig {
    /// 软解软编 —— **现状行为**，也是硬解失败时的回落目标。
    pub fn software() -> Self {
        FfmpegConfig {
            hwaccel: None,
            device: None,
            hw_encode: false,
        }
    }

    /// **输入侧**参数，顺序固定：`["-hwaccel", <后端>]` 后接 `["-hwaccel_device", <设备>]`。
    ///
    /// 必须放在 `-i <src>` **之前**才生效。软解 ⇒ 返回**空 `Vec`**（不往命令行里塞任何东西，
    /// 保证与现状逐字一致）。
    ///
    /// ★ 本函数**只**产出输入侧参数：**禁止**在此处动 preset / crf / fps / `-vf` / `-af`。
    pub fn input_args(&self) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        let Some(hwaccel) = self.hwaccel else {
            return args; // 软解：零参数，与现状完全一致
        };

        args.push("-hwaccel".to_string());
        args.push(hwaccel.as_str().to_string());
        if let Some(device) = &self.device {
            args.push("-hwaccel_device".to_string());
            args.push(device.clone());
        }

        args
    }

    /// 硬解初始化失败时的**回落目标** —— 恒等于 [`FfmpegConfig::software`]。
    ///
    /// §2.5.4 硬约束：硬解失败必须**回落软解重试一次**并写日志，
    /// **不得让「硬解失败」表现为「放不了」**（BUG-237「未安装降级」原则在硬解上的同一形态）。
    pub fn fallback(&self) -> Self {
        FfmpegConfig::software()
    }

    /// 是否为软解软编。
    pub fn is_software(&self) -> bool {
        self.hwaccel.is_none()
    }
}

impl Default for FfmpegConfig {
    fn default() -> Self {
        FfmpegConfig::software()
    }
}

/// 一台机器的**静态 ffmpeg 能力**快照。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Caps {
    /// `ffmpeg -hwaccels` 解析结果（小写、去重）。
    pub hwaccels: Vec<String>,
    /// `ffmpeg -encoders` 解析结果（全量编码器名，含软编）。
    pub encoders: Vec<String>,
    /// 探测到的显卡（`nvidia-smi` + WMI，已去重）。
    pub gpus: Vec<Gpu>,
}

impl Caps {
    /// 是否支持某个硬解后端（大小写不敏感）。
    pub fn has_hwaccel(&self, name: &str) -> bool {
        let target = name.trim().to_lowercase();
        self.hwaccels.iter().any(|h| h == &target)
    }

    /// 是否存在某厂商的**独显**。
    pub fn has_dedicated(&self, vendor: Vendor) -> bool {
        self.gpus
            .iter()
            .any(|gpu| gpu.vendor == vendor && gpu.dedicated)
    }

    /// 可用的**硬件编码器**（可能为空 —— 本机实测就为空）。
    pub fn hw_encoders(&self) -> Vec<String> {
        hardware_encoders(&self.encoders)
    }

    /// [`recommend`] 的方法形式（转发，逻辑只有一处）。
    pub fn recommend(&self) -> FfmpegConfig {
        recommend(self)
    }
}

/// 按 §2.5.4 ② 的保守默认决策表产出推荐配置（**顺序即优先级**）。
///
/// | 情形 | 推荐 |
/// |---|---|
/// | 有 NVIDIA 独显 且 `hwaccels` 含 `cuda` | `cuda` + 设备 `"0"` |
/// | 有 AMD 独显 且 `hwaccels` 含 `d3d11va` | `d3d11va`，不指定设备 |
/// | 只有核显 / 无 GPU 信息 | `d3d11va` → `qsv` → `dxva2` → 软解 |
/// | `hwaccels` 为空 | 软解 |
///
/// ★ 两条硬约束：
/// - `hw_encode` **恒为 `false`**（硬件编码仅作可选项，默认软编）；
/// - 任何路径都**不得**产出 `auto`（[`HwAccel`] 无 `Auto` 变体，物理上不可能）。
pub fn recommend(caps: &Caps) -> FfmpegConfig {
    if caps.hwaccels.is_empty() {
        return FfmpegConfig::software();
    }

    // 有独显 ⇒ 显式后端 + 显式设备，不依赖 auto 的选择（§2.5.6）
    if caps.has_dedicated(Vendor::Nvidia) && caps.has_hwaccel("cuda") {
        return FfmpegConfig {
            hwaccel: Some(HwAccel::Cuda),
            device: Some("0".to_string()),
            hw_encode: false,
        };
    }
    if caps.has_dedicated(Vendor::Amd) && caps.has_hwaccel("d3d11va") {
        return FfmpegConfig {
            hwaccel: Some(HwAccel::D3d11va),
            device: None,
            hw_encode: false,
        };
    }

    // 只有核显 / 未知 GPU ⇒ 按后端成熟度挑一个可用的（Windows 上 d3d11va 优先于 dxva2）
    if caps.has_hwaccel("d3d11va") {
        return FfmpegConfig {
            hwaccel: Some(HwAccel::D3d11va),
            device: None,
            hw_encode: false,
        };
    }
    if caps.has_hwaccel("qsv") {
        return FfmpegConfig {
            hwaccel: Some(HwAccel::Qsv),
            device: None,
            hw_encode: false,
        };
    }
    if caps.has_hwaccel("dxva2") {
        return FfmpegConfig {
            hwaccel: Some(HwAccel::Dxva2),
            device: None,
            hw_encode: false,
        };
    }

    FfmpegConfig::software()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机 `ffmpeg -hwaccels` 的真实输出形态（含版本 banner，证明 banner 被跳过）。
    const REAL_HWACCELS: &str = "\
ffmpeg version 6.0-full_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers
Hardware acceleration methods:
cuda
vaapi
dxva2
qsv
d3d11va
d3d12va
amf
";

    /// 含三家硬件编码器的 `ffmpeg -encoders` 片段（含表头 / 图例 / 分隔线）。
    const ENCODERS_WITH_HW: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 / AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding) (codec aac)
";

    /// 只有软编的 `ffmpeg -encoders` 片段。
    const ENCODERS_SOFTWARE_ONLY: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding) (codec aac)
";

    /// 本机 `nvidia-smi -L` 单行输出。
    const NVIDIA_SMI_3060: &str = "GPU 0: NVIDIA GeForce RTX 3060 Laptop GPU (UUID: GPU-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d)\n";

    /// WMI `Win32_VideoController` CSV（首行列名，含 NVIDIA 卡 + Intel 核显）。
    const WMI_CSV_MULTI: &str = "\
Name,AdapterRAM,DriverVersion
NVIDIA GeForce RTX 3060 Laptop GPU,4293918720,31.0.15.3623
Intel(R) UHD Graphics,1073741824,30.0.101.1994
";

    /// 只有一张 NVIDIA 卡的 WMI CSV（与 `NVIDIA_SMI_3060` 同名，用于验去重）。
    const WMI_CSV_3060_ONLY: &str = "\
Name,AdapterRAM,DriverVersion
NVIDIA GeForce RTX 3060 Laptop GPU,4293918720,31.0.15.3623
";

    /// 1. parse_hwaccels：本机真实 7 后端文本 ⇒ 7 个，含全部七者。
    #[test]
    fn parse_hwaccels_real_output_yields_all_seven_backends() {
        let got = parse_hwaccels(REAL_HWACCELS);
        assert_eq!(got.len(), 7, "实际解析结果: {got:?}");
        for expected in ["cuda", "vaapi", "dxva2", "qsv", "d3d11va", "d3d12va", "amf"] {
            assert!(
                got.iter().any(|h| h == expected),
                "缺少后端 {expected}: {got:?}"
            );
        }
    }

    /// 2. parse_hwaccels：空串 / 只有标题行 ⇒ 空。
    #[test]
    fn parse_hwaccels_empty_or_title_only_yields_nothing() {
        assert!(parse_hwaccels("").is_empty(), "空串必须解析为空");
        assert!(
            parse_hwaccels("Hardware acceleration methods:").is_empty(),
            "只有标题行必须解析为空"
        );
        assert!(
            parse_hwaccels("Hardware acceleration methods:\n\n   \n").is_empty(),
            "标题 + 空行必须解析为空"
        );
    }

    /// 3. parse_encoders：含 h264_nvenc / h264_qsv / h264_amf ⇒ 三个都命中。
    #[test]
    fn parse_encoders_extracts_hardware_encoders() {
        let got = parse_encoders(ENCODERS_WITH_HW);
        for expected in ["h264_nvenc", "h264_qsv", "h264_amf"] {
            assert!(
                got.iter().any(|e| e == expected),
                "缺少编码器 {expected}: {got:?}"
            );
        }
        // 表头 / 图例 / 分隔线不得混进来
        assert!(!got.iter().any(|e| e == "------" || e == "="), "{got:?}");
        assert_eq!(
            hardware_encoders(&got),
            vec![
                "h264_nvenc".to_string(),
                "h264_qsv".to_string(),
                "h264_amf".to_string()
            ]
        );
    }

    /// 4. parse_encoders：无硬件编码器 ⇒ 硬件编码器列表为空。
    #[test]
    fn parse_encoders_without_hardware_encoders_yields_no_hw() {
        let got = parse_encoders(ENCODERS_SOFTWARE_ONLY);
        // 软编编码器照常被抽出（本函数返回全量）
        assert!(got.iter().any(|e| e == "libx264"), "{got:?}");
        // 但没有任何硬件编码器 —— 正是本机的实况
        assert!(
            hardware_encoders(&got).is_empty(),
            "不该有硬件编码器: {got:?}"
        );
        assert!(parse_encoders("").is_empty(), "空串 ⇒ 空");
    }

    /// 5. parse_gpu_list：nvidia-smi 单行 ⇒ 1 条 NVIDIA 独显。
    #[test]
    fn parse_gpu_list_nvidia_smi_single_line_is_one_dedicated_gpu() {
        let gpus = parse_gpu_list(Some(NVIDIA_SMI_3060), None);
        assert_eq!(gpus.len(), 1, "{gpus:?}");
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 3060 Laptop GPU");
        assert_eq!(gpus[0].vendor, Vendor::Nvidia);
        assert!(gpus[0].dedicated, "RTX 3060 必须判定为独显");
        assert_eq!(gpus[0].memory_bytes, None, "nvidia-smi -L 不输出显存");
    }

    /// 6. parse_gpu_list：nvidia-smi + WMI 同卡 ⇒ 去重后仍 1 条（nvidia-smi 优先）。
    #[test]
    fn parse_gpu_list_dedups_same_card_across_sources() {
        let gpus = parse_gpu_list(Some(NVIDIA_SMI_3060), Some(WMI_CSV_3060_ONLY));
        assert_eq!(gpus.len(), 1, "同名卡必须去重: {gpus:?}");
        assert_eq!(gpus[0].vendor, Vendor::Nvidia);
        assert!(gpus[0].dedicated);

        // 两个来源都给出信息时，不同名的卡都要保留（iGPU + 独显 = 多显卡）
        let multi = parse_gpu_list(Some(NVIDIA_SMI_3060), Some(WMI_CSV_MULTI));
        assert_eq!(multi.len(), 2, "iGPU 与独显都要保留: {multi:?}");
        assert!(multi.iter().any(|g| g.vendor == Vendor::Intel && !g.dedicated));
        assert!(multi.iter().any(|g| g.vendor == Vendor::Nvidia && g.dedicated));
    }

    /// 7. recommend(iGPU + RTX3060，cuda 可用) ⇒ Cuda + device="0"，且**不是 auto**。
    ///
    /// 本机实况：Intel iGPU + RTX 3060 Laptop，`ffmpeg -hwaccels` 含 cuda。
    #[test]
    fn recommend_multi_gpu_prefers_explicit_cuda_over_auto() {
        let caps = Caps {
            hwaccels: parse_hwaccels(REAL_HWACCELS),
            encoders: parse_encoders(ENCODERS_WITH_HW),
            gpus: parse_gpu_list(Some(NVIDIA_SMI_3060), Some(WMI_CSV_MULTI)),
        };
        let cfg = recommend(&caps);
        assert_eq!(cfg.hwaccel, Some(HwAccel::Cuda));
        assert_eq!(cfg.device.as_deref(), Some("0"));

        let args = cfg.input_args();
        assert_eq!(args, vec!["-hwaccel", "cuda", "-hwaccel_device", "0"]);
        // ★ 反向断言：任何路径都不得产出 auto
        assert!(
            !args.iter().any(|a| a.eq_ignore_ascii_case("auto")),
            "不得产出 auto: {args:?}"
        );
        assert_eq!(HwAccel::from_name("auto"), None, "auto 不是合法后端");
    }

    /// 8. recommend(仅 iGPU，d3d11va 可用) ⇒ D3d11va，device=None。
    #[test]
    fn recommend_integrated_gpu_only_picks_d3d11va_without_device() {
        let caps = Caps {
            hwaccels: vec!["d3d11va".to_string(), "dxva2".to_string(), "qsv".to_string()],
            encoders: Vec::new(),
            gpus: vec![Gpu {
                name: "Intel(R) UHD Graphics".to_string(),
                vendor: Vendor::Intel,
                dedicated: false,
                memory_bytes: Some(1073741824),
            }],
        };
        let cfg = recommend(&caps);
        assert_eq!(cfg.hwaccel, Some(HwAccel::D3d11va));
        assert_eq!(cfg.device, None, "无独显时不指定设备");
        assert!(!cfg.is_software());
        assert_eq!(cfg.input_args(), vec!["-hwaccel", "d3d11va"]);
    }

    /// 9. recommend(hwaccels 为空) ⇒ is_software() 且 input_args() 为空。
    #[test]
    fn recommend_without_hwaccels_is_software_with_empty_args() {
        let caps = Caps {
            hwaccels: Vec::new(),
            encoders: parse_encoders(ENCODERS_WITH_HW),
            gpus: parse_gpu_list(Some(NVIDIA_SMI_3060), None),
        };
        let cfg = recommend(&caps);
        assert!(cfg.is_software(), "无硬解后端必须软解: {cfg:?}");
        assert!(
            cfg.input_args().is_empty(),
            "软解不得往命令行塞任何参数: {:?}",
            cfg.input_args()
        );
        assert_eq!(cfg, FfmpegConfig::software());
    }

    /// 10. recommend(有 h264_nvenc) ⇒ hw_encode 仍为 false；
    ///     input_args 顺序固定为 `-hwaccel` 先于 `-hwaccel_device`；fallback() 恒为软解。
    #[test]
    fn hardware_encoder_present_still_soft_encodes_and_fallback_is_software() {
        let caps = Caps {
            hwaccels: parse_hwaccels(REAL_HWACCELS),
            encoders: parse_encoders(ENCODERS_WITH_HW),
            gpus: parse_gpu_list(Some(NVIDIA_SMI_3060), Some(WMI_CSV_MULTI)),
        };
        assert!(
            caps.hw_encoders().iter().any(|e| e == "h264_nvenc"),
            "前置条件：确实探测到了 h264_nvenc"
        );

        let cfg = recommend(&caps);
        // ★ 硬件编码只作可选项，默认关（§2.5.4 ②）
        assert!(!cfg.hw_encode, "硬件编码默认必须关闭: {cfg:?}");

        // ★ 顺序断言：`-hwaccel` 必须在 `-hwaccel_device` 之前
        let args = cfg.input_args();
        assert_eq!(args, vec!["-hwaccel", "cuda", "-hwaccel_device", "0"]);
        assert_eq!(args.first().map(String::as_str), Some("-hwaccel"));
        assert_eq!(args.get(2).map(String::as_str), Some("-hwaccel_device"));

        // ★ 回落：硬解初始化失败必须回到软解，且软解零参数
        let fb = cfg.fallback();
        assert!(fb.is_software(), "回落目标必须是软解: {fb:?}");
        assert_eq!(fb, FfmpegConfig::software());
        assert!(fb.input_args().is_empty());
        // 幂等：软解再回落仍是软解
        assert!(fb.fallback().is_software());
    }

    /// 11.（附加）WMI 单独来源也能解析，列名定位而非硬编码列号。
    #[test]
    fn parse_gpu_list_wmi_only_locates_columns_by_name() {
        // 列序调换：AdapterRAM 在前、Name 在后，仍能正确解析
        let csv = "\
AdapterRAM,DriverVersion,Name
1073741824,30.0.101.1994,Intel(R) UHD Graphics
";
        let gpus = parse_gpu_list(None, Some(csv));
        assert_eq!(gpus.len(), 1, "{gpus:?}");
        assert_eq!(gpus[0].name, "Intel(R) UHD Graphics");
        assert_eq!(gpus[0].vendor, Vendor::Intel);
        assert!(!gpus[0].dedicated, "Intel 核显不是独显");
        assert_eq!(gpus[0].memory_bytes, Some(1073741824));
        assert!(parse_gpu_list(None, None).is_empty(), "两源皆空 ⇒ 空列表");
    }

    /// 12.（附加）`HwAccel::from_name` / `as_str` 往返一致，且不认 `auto`。
    #[test]
    fn hwaccel_name_roundtrip_rejects_auto() {
        for (name, variant) in [
            ("cuda", HwAccel::Cuda),
            ("d3d11va", HwAccel::D3d11va),
            ("dxva2", HwAccel::Dxva2),
            ("qsv", HwAccel::Qsv),
            ("vaapi", HwAccel::Vaapi),
            ("amf", HwAccel::Amf),
            ("d3d12va", HwAccel::D3d12va),
        ] {
            assert_eq!(HwAccel::from_name(name), Some(variant));
            assert_eq!(variant.as_str(), name);
            // 大小写不敏感
            assert_eq!(HwAccel::from_name(&name.to_uppercase()), Some(variant));
        }
        assert_eq!(HwAccel::from_name("auto"), None);
        assert_eq!(HwAccel::from_name(""), None);
    }
}
