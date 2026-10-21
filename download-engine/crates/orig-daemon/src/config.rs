//! 守护进程配置：下载目录、并发数、鉴权 token、端口、自动分类。
//!
//! 加载顺序（对齐 orig-hub `internal/config` 的「配置存储」语义）：
//!   1. 环境变量（优先，便于容器/CI 覆盖）
//!   2. `download-engine.toml` 简单 `key = "value"` 行 + `[classify]` 段
//!
//! Download directory three-layer resolution, see [`resolve_output`]:
//!   request output_path → config download_dir → platform default directory
//!   (OS known folder; never a literal `~/Downloads`, see BUG-071)

use std::collections::HashMap;
use std::path::PathBuf;

/// 自动分类配置（R3）。
#[derive(Debug, Clone)]
pub struct ClassifyConfig {
    /// 是否启用自动分类（默认 false）。
    pub enabled: bool,
    /// 扩展名 -> 分类目录名映射（覆盖内置默认）。
    pub map: HashMap<String, String>,
}

impl Default for ClassifyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            map: HashMap::new(),
        }
    }
}

impl ClassifyConfig {
    /// 内置默认分类映射。
    fn defaults() -> HashMap<String, String> {
        let mut m = HashMap::new();
        // 视频
        for ext in ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "rmvb"] {
            m.insert(ext.to_string(), "Videos".to_string());
        }
        // 音频
        for ext in ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus", "ape"] {
            m.insert(ext.to_string(), "Music".to_string());
        }
        // 图片
        for ext in ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif", "heic"] {
            m.insert(ext.to_string(), "Images".to_string());
        }
        // 文档
        for ext in ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "epub", "mobi"] {
            m.insert(ext.to_string(), "Documents".to_string());
        }
        // 压缩包
        for ext in ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso"] {
            m.insert(ext.to_string(), "Archives".to_string());
        }
        m
    }

    /// 合并配置文件映射与内置默认（配置优先）。
    pub fn merged_map(&self) -> HashMap<String, String> {
        let mut m = Self::defaults();
        for (k, v) in &self.map {
            m.insert(k.clone(), v.clone());
        }
        m
    }

    /// 按 filename 扩展名返回分类目录名（无扩展名或未知返回 "Others"）。
    pub fn classify(&self, filename: &str) -> String {
        let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
        if ext.is_empty() {
            return "Others".to_string();
        }
        self.merged_map().get(&ext).cloned().unwrap_or_else(|| "Others".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// 默认下载目录（来自配置/环境变量）。为空时回退平台默认目录。
    pub download_dir: Option<PathBuf>,
    /// 受管库根（D23-A：手动下载与插件入库同处一个受管根，设置一处可配）。
    ///
    /// **BUG-323（用户 2026-10-16 裁定）**：手动下载**从未配置** `download_dir` 时的
    /// 默认根**不再**绑 `<library_dir>/下载/`，而是直接回退**平台默认下载目录**
    /// （见 [`manual_download_root`]）。库根此处仅作展示/持久化，不再决定下载落点。
    /// **插件（TG）归仓路径不经此处** —— 它由插件自管。
    pub library_dir: Option<PathBuf>,
    /// 默认并发连接数（对齐 orig-hub `max_connections` 缺省 8）。
    pub max_connections: u32,
    /// Bearer token；为空表示不鉴权（对齐 orig-hub：token 空则不校验）。
    pub token: Option<String>,
    /// 监听端口（缺省 19786，见 `Default`）。
    pub port: u16,
    /// 监听地址（缺省 127.0.0.1；容器/远程部署设 0.0.0.0 以接受外部连接）。
    pub host: String,
    /// 允许的 CORS 源（逗号/空格分隔；为空则回退桌面端默认白名单）。
    pub cors_origins: Vec<String>,
    /// 自动分类配置（R3）。
    pub classify: ClassifyConfig,
    /// HTTP 下载代理配置（默认直连）。
    pub proxy: orig_core::protocol::ProxyConfig,
    /// TG 可选插件：true 时 daemon 拉起 orig-tg 子服务（注入主配置代理），false 时终止并隐藏模块。
    pub tg_enabled: bool,
    /// TG MTProto 应用凭证 api_id（`[tg]` 段；orig-tg real 模式，非空才注入）。
    pub tg_api_id: Option<String>,
    /// TG MTProto 应用凭证 api_hash（`[tg]` 段）。
    pub tg_api_hash: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            download_dir: None,
            library_dir: None,
            max_connections: 8,
            token: None,
            // 19786（原 9876）：9876 常被 Windows 划进动态保留区（9857–9956 实证），
            // bind 恒 10013，服务起不来而现象看着像「进程自杀」（BUG-178）。
            // 仍可被配置文件 `port` 覆盖；bind 失败时 main 还有顺延兜底，
            // 实际端口以 `/api/config` 的 `port` 为准。
            port: 19786,
            host: "127.0.0.1".to_string(),
            cors_origins: Vec::new(),
            classify: ClassifyConfig::default(),
            proxy: orig_core::protocol::ProxyConfig::default(),
            tg_enabled: true,
            tg_api_id: None,
            tg_api_hash: None,
        }
    }
}

/// 轻量 toml 解析：支持 `key = "value"` 与 `[section]` 段、`[[array]]` 数组段。
/// 只覆盖本项目需要的最小语法，不引入 toml crate。
struct TomlParser {
    /// 当前段名（None = 顶层）。
    section: Option<String>,
    /// 顶层键值。
    top: HashMap<String, String>,
    /// section -> 键值表。
    sections: HashMap<String, HashMap<String, String>>,
    /// 数组段收集（如 [[classify.map]]）。
    arrays: Vec<(String, HashMap<String, String>)>,
}

impl TomlParser {
    fn parse(text: &str) -> Self {
        let mut p = TomlParser {
            section: None,
            top: HashMap::new(),
            sections: HashMap::new(),
            arrays: Vec::new(),
        };
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line.starts_with("[[") && line.ends_with("]]") {
                let name = line[2..line.len() - 2].trim().to_string();
                p.section = None;
                p.arrays.push((name, HashMap::new()));
            } else if line.starts_with('[') && line.ends_with(']') {
                let name = line[1..line.len() - 1].trim().to_string();
                p.section = Some(name);
            } else if let Some((k, v)) = line.split_once('=') {
                let k = k.trim().to_string();
                let v = v.trim().trim_matches('"').to_string();
                if let Some(sec) = &p.section {
                    p.sections.entry(sec.clone()).or_default().insert(k, v);
                } else if let Some((_, last)) = p.arrays.last_mut() {
                    last.insert(k, v);
                } else {
                    p.top.insert(k, v);
                }
            }
        }
        p
    }

    /// 取顶层键值。
    fn top_value(&self, key: &str) -> Option<&String> {
        self.top.get(key)
    }

    /// 取指定段的键值表。
    fn section(&self, name: &str) -> Option<&HashMap<String, String>> {
        self.sections.get(name)
    }

    /// 取数组段所有元素。
    fn array(&self, name: &str) -> Vec<&HashMap<String, String>> {
        self.arrays.iter().filter(|(n, _)| n == name).map(|(_, m)| m).collect()
    }
}

impl Config {
    /// 加载配置：环境变量优先，其次 `download-engine.toml`。
    pub fn load() -> Self {
        Self::load_from("download-engine.toml")
    }

    /// 从指定路径加载（测试可注入）。
    pub fn load_from(path: &str) -> Self {
        let mut cfg = Config::default();

        // 注：环境变量覆盖统一在 toml 解析之后应用（见函数末尾），
        // 保证容器/远程部署的 env 始终优先于挂载的 download-engine.toml。
        if let Ok(txt) = std::fs::read_to_string(path) {
            let parser = TomlParser::parse(&txt);

            // 顶层键值
            for (k, v) in &parser.top {
                match k.as_str() {
                    "download_dir" if !v.is_empty() => {
                        // Legacy configs may hold `~/Downloads`; expand it here so
                        // an upgrade never lands in `<CWD>/~/Downloads` (BUG-071).
                        // BUG-323 复报（2026-10-19）：再收敛分隔符字面 —— 活栈
                        // 实测存量 toml 里存着 `D://OrigDown`（双斜杠），读取侧
                        // 归一化后无需手工改库即恢复 `D:/OrigDown`。
                        cfg.download_dir = Some(orig_core::paths::normalize_dir_path(
                            &orig_core::paths::expand_tilde(v),
                        ))
                    }
                    "library_dir" if !v.is_empty() => {
                        // 受管库根（D23-A）；同 `download_dir`，旧值里的 `~` 在读取期展开。
                        cfg.library_dir = Some(orig_core::paths::expand_tilde(v))
                    }
                    "max_connections" => {
                        if let Ok(n) = v.parse() { cfg.max_connections = n; }
                    }
                    "token" if !v.is_empty() => cfg.token = Some(v.clone()),
                    "port" => {
                        if let Ok(n) = v.parse() { cfg.port = n; }
                    }
                    "host" if !v.is_empty() => cfg.host = v.clone(),
                    "cors_origins" if !v.is_empty() => {
                        cfg.cors_origins = v
                            .split([',', ' '])
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                    }
                    _ => {}
                }
            }

            // [classify] 段
            if let Some(sec) = parser.section("classify") {
                if let Some(v) = sec.get("enabled") {
                    cfg.classify.enabled = v == "true" || v == "1";
                }
                for entry in parser.array("classify.map") {
                    if let (Some(ext), Some(cat)) = (entry.get("ext"), entry.get("category")) {
                        if !ext.is_empty() && !cat.is_empty() {
                            cfg.classify.map.insert(ext.clone(), cat.clone());
                        }
                    }
                }
            }

            // [proxy] 段（HTTP 下载代理；BT/DHT 代理未来独立段，同结构）
            if let Some(sec) = parser.section("proxy") {
                if let Some(v) = sec.get("mode") {
                    cfg.proxy.mode = match v.as_str() {
                        "system" => orig_core::protocol::ProxyMode::System,
                        "custom" => orig_core::protocol::ProxyMode::Custom,
                        _ => orig_core::protocol::ProxyMode::Direct,
                    };
                }
                if let Some(v) = sec.get("url") {
                    if !v.is_empty() {
                        cfg.proxy.url = Some(v.clone());
                    }
                }
            }

            // [tg] 段（TG 可选插件开关 + MTProto 应用凭证）
            if let Some(sec) = parser.section("tg") {
                if let Some(v) = sec.get("enabled") {
                    cfg.tg_enabled = v == "true" || v == "1";
                }
                if let Some(v) = sec.get("api_id") {
                    if !v.is_empty() {
                        cfg.tg_api_id = Some(v.clone());
                    }
                }
                if let Some(v) = sec.get("api_hash") {
                    if !v.is_empty() {
                        cfg.tg_api_hash = Some(v.clone());
                    }
                }
            }
        }

        // 环境变量覆盖（在 toml 之后）：容器/远程部署用 env 始终优先于挂载的 toml。
        if let Ok(d) = std::env::var("SURGE_DOWNLOAD_DIR") {
            if !d.is_empty() {
                cfg.download_dir = Some(orig_core::paths::normalize_dir_path(
                    &orig_core::paths::expand_tilde(&d),
                ));
            }
        }
        // 受管库根（D23-A）：设置页保存「库根目录」时同步写入；`ORIG_TG_LIBRARY_DIR`
        // 作为兼容别名（M1 把库根迁入 daemon 之前，TG 侧用的就是这个名字）。
        if let Ok(d) = std::env::var("ORIG_DAEMON_LIBRARY_DIR")
            .or_else(|_| std::env::var("ORIG_TG_LIBRARY_DIR"))
        {
            if !d.is_empty() {
                cfg.library_dir = Some(orig_core::paths::expand_tilde(&d));
            }
        }
        if let Ok(m) = std::env::var("SURGE_MAX_CONNECTIONS") {
            if let Ok(v) = m.parse() {
                cfg.max_connections = v;
            }
        }
        if let Ok(t) = std::env::var("SURGE_TOKEN") {
            if !t.is_empty() {
                cfg.token = Some(t);
            }
        }
        if let Ok(p) = std::env::var("PORT") {
            if let Ok(v) = p.parse() {
                cfg.port = v;
            }
        }
        // 监听地址：容器/远程部署用 ORIG_DAEMON_HOST（或 SURGE_HOST 别名）覆盖默认 127.0.0.1。
        if let Ok(h) = std::env::var("ORIG_DAEMON_HOST").or_else(|_| std::env::var("SURGE_HOST")) {
            if !h.is_empty() {
                cfg.host = h;
            }
        }
        // 允许的 CORS 源（逗号/空格分隔）；为空则保持桌面端默认白名单。
        if let Ok(c) = std::env::var("ORIG_CORS_ORIGINS") {
            let parts: Vec<String> = c
                .split([',', ' '])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !parts.is_empty() {
                cfg.cors_origins = parts;
            }
        }
        // TG 可选插件开关（与 toml [tg] enabled 等效，便于容器/无界面部署关闭）。
        if let Ok(v) = std::env::var("ORIG_TG_ENABLED") {
            cfg.tg_enabled = v == "true" || v == "1";
        }
        // 代理：容器/无界面部署用 ORIG_PROXY_MODE / ORIG_PROXY_URL 覆盖 toml [proxy]，
        // 无需挂载配置文件即可让 HTTP 下载与 Telegram 走代理。
        if let Ok(m) = std::env::var("ORIG_PROXY_MODE") {
            cfg.proxy.mode = match m.as_str() {
                "system" => orig_core::protocol::ProxyMode::System,
                "custom" => orig_core::protocol::ProxyMode::Custom,
                _ => orig_core::protocol::ProxyMode::Direct,
            };
        }
        if let Ok(u) = std::env::var("ORIG_PROXY_URL") {
            if !u.is_empty() {
                cfg.proxy.url = Some(u);
            }
        }

        cfg
    }

    /// 将自动分类规则持久化到 `download-engine.toml`（保留既有键值；仅重写 [classify] 段）。
    /// 返回写出的完整文本。
    pub fn save_classify_map(&self, map: &HashMap<String, String>) -> std::io::Result<String> {
        self.save_classify_map_to("download-engine.toml", map)
    }

    /// 同 [`Config::save_classify_map`]，但可指定目标路径（测试注入）。
    pub fn save_classify_map_to(
        &self,
        path: &str,
        map: &HashMap<String, String>,
    ) -> std::io::Result<String> {
        let existing = std::fs::read_to_string(path).unwrap_or_default();
        let mut out = String::new();
        let mut in_classify = false;
        let mut classify_started = false;
        for raw in existing.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim();
            if in_classify {
                // 仍在旧 [classify] 段内（含 [[classify.map]] 数组段）：整段跳过，末尾重写
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    if trimmed == "[classify]" || trimmed == "[[classify.map]]" {
                        continue;
                    }
                    in_classify = false; // 进入其它新段
                } else {
                    continue;
                }
            }
            if trimmed == "[classify]" || trimmed == "[[classify.map]]" {
                in_classify = true;
                classify_started = true;
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        // 追加 [classify] 段（旧段已整段跳过；无旧段时补一个空行分隔）
        if !classify_started {
            if !out.trim().is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
        }
        out.push_str("[classify]\n");
        out.push_str(&format!("enabled = {}\n", if self.classify.enabled { "true" } else { "false" }));
        for (ext, cat) in map {
            out.push_str(&format!("[[classify.map]]\next = \"{ext}\"\ncategory = \"{cat}\"\n"));
        }
        std::fs::write(path, &out)?;
        Ok(out)
    }

    /// 保存下载目录（顶层键 `download_dir`）：运行时生效 + 持久化到 `download-engine.toml`。
    ///
    /// 与 `[classify]`/`[proxy]`/`[tg]` 段重写器不同，它是**顶层键**（`config.rs` 的
    /// 顶层键解析分支），段重写器帮不上忙，单独实现、语义相同。
    /// 写入用正斜杠：TOML 最小解析器只 `trim_matches('"')` 不做反转义，
    /// Windows 路径若写反斜杠会被 TOML 当转义序列，读回即坏。
    pub fn save_download_dir(&self, path: &str) -> std::io::Result<String> {
        let existing = std::fs::read_to_string(path).unwrap_or_default();
        // BUG-323 复报（2026-10-19）：先归一化再落盘。此前只 `replace('\\', "/")`
        // 不折叠重复分隔符 ⇒ 用户输入的 `D:\\OrigDown` 会原样写成 `D://OrigDown`，
        // 与目录浏览器/历史目录给出的形态在系统里各算一套。
        let value = self
            .download_dir
            .as_ref()
            .map(|p| orig_core::paths::normalize_dir(&p.to_string_lossy()))
            .unwrap_or_default();
        let mut out = String::new();
        let mut written = false;
        for raw in existing.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim();
            // 已有 download_dir 行：值非空则原地替换，空值则（清空设置）删除该行。
            if trimmed.starts_with("download_dir") && trimmed.contains('=') {
                if !value.is_empty() {
                    out.push_str(&format!("download_dir = \"{value}\"\n"));
                    written = true;
                }
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        if !written && !value.is_empty() {
            out = format!("download_dir = \"{value}\"\n{out}");
        }
        std::fs::write(path, &out)?;
        Ok(out)
    }

    /// ~~保存受管库根~~ —— **已删（BUG-323）**：库根是 `<生效下载路径>/library` 的
    /// 派生值，没有独立写入口（`PUT /api/config/library` 恒 422）。
    /// 保留 `library_dir` 的**读取**只是为了让旧 toml 不报错，别再无写路径。

    /// 将代理配置持久化到 `download-engine.toml` 的 `[proxy]` 段（保留其它段）。
    /// 返回写出的完整文本。
    pub fn save_proxy(&self, path: &str) -> std::io::Result<String> {
        let existing = std::fs::read_to_string(path).unwrap_or_default();
        let mut out = String::new();
        let mut in_proxy = false;
        let mut proxy_started = false;
        for raw in existing.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim();
            if in_proxy {
                // 仍在旧 [proxy] 段内：整段跳过，末尾重写
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    if trimmed == "[proxy]" {
                        continue;
                    }
                    in_proxy = false;
                } else {
                    continue;
                }
            }
            if trimmed == "[proxy]" {
                in_proxy = true;
                proxy_started = true;
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        if !proxy_started {
            if !out.trim().is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
        }
        let mode_str = match self.proxy.mode {
            orig_core::protocol::ProxyMode::Direct => "direct",
            orig_core::protocol::ProxyMode::System => "system",
            orig_core::protocol::ProxyMode::Custom => "custom",
        };
        out.push_str("[proxy]\n");
        out.push_str(&format!("mode = \"{mode_str}\"\n"));
        match &self.proxy.url {
            Some(u) => out.push_str(&format!("url = \"{u}\"\n")),
            None => out.push_str("url = \"\"\n"),
        }
        std::fs::write(path, &out)?;
        Ok(out)
    }

    /// 将 TG 插件开关持久化到 `download-engine.toml` 的 `[tg]` 段（保留其它段）。
    /// 返回写出的完整文本。
    pub fn save_tg(&self, path: &str) -> std::io::Result<String> {
        let existing = std::fs::read_to_string(path).unwrap_or_default();
        let mut out = String::new();
        let mut in_tg = false;
        let mut tg_started = false;
        for raw in existing.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim();
            if in_tg {
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    if trimmed == "[tg]" {
                        continue;
                    }
                    in_tg = false;
                } else {
                    continue;
                }
            }
            if trimmed == "[tg]" {
                in_tg = true;
                tg_started = true;
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        if !tg_started {
            if !out.trim().is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
        }
        out.push_str("[tg]\n");
        out.push_str(&format!("enabled = {}\n", if self.tg_enabled { "true" } else { "false" }));
        if let Some(id) = &self.tg_api_id {
            if !id.is_empty() {
                out.push_str(&format!("api_id = \"{id}\"\n"));
            }
        }
        if let Some(h) = &self.tg_api_hash {
            if !h.is_empty() {
                out.push_str(&format!("api_hash = \"{h}\"\n"));
            }
        }
        std::fs::write(path, &out)?;
        Ok(out)
    }
}

/// Platform default download directory.
///
/// Delegates to [`orig_core::paths::default_download_dir`]: the OS known-folder
/// API (Windows `SHGetKnownFolderPath(FOLDERID_Downloads)`), so a user-relocated
/// Downloads folder is honoured and `$HOME` is never probed by hand (BUG-071).
pub fn default_download_dir() -> PathBuf {
    orig_core::paths::default_download_dir()
}

/// 手动下载的**默认根** —— 三层链里「配置 download_dir 为空」那一层。
///
/// **BUG-323（用户 2026-10-16 裁定）**：默认根 = **平台默认下载目录**
/// （Windows = `SHGetKnownFolderPath(FOLDERID_Downloads)`，如 `C:\Users\<user>\Downloads`）。
///
/// 历史：D23-A① 曾把它定为 `<library_dir>/下载/` —— 方向正好反了。库根解析链末端是
/// **内部 AppData 隐藏路径**（`<TG 数据目录>/library`），于是「默认下载根」变成用户
/// 找不到的 `…AppData/…/tg/library/下载`（用户：「毫无逻辑性」）。现在是
/// **下载路径为唯一根、库根从属于它**（见 [`library_root`]）。
///
/// `cfg` 参数保留仅为**不动调用方签名**（`resolve_output` / `routes`）；不再读取它 ——
/// 用户显式配置的 `download_dir` 由上游分支优先命中，不会走到这里。
pub fn manual_download_root(_cfg: &Config) -> PathBuf {
    // 与 `effective_download_root` 同一条禁用盘规则（用户 2026-10-19 裁定）：
    // 名义默认 `~/Downloads` 落在系统盘 / 裸根上 ⇒ 手动下载的落点改取 D 盘内容根。
    let d = default_download_dir();
    if orig_core::paths::is_valid_content_root(&d) {
        d
    } else {
        orig_core::paths::content_root()
    }
}

/// **生效下载路径** = 受管根 / 权限边界（BUG-323）：配置的 `download_dir`
/// （`~` 已在读取期展开）→ 否则平台默认下载目录。
///
/// 这是全部用户内容字节（下载成品、归仓媒体、转码代理）的唯一容器；前端设置页
/// 展示的「当前生效」路径即此值，前端**不自己拼**（拼出来必然漂移）。
///
/// **C 盘禁用（用户 2026-10-19 裁定）**：「禁止往C盘写入任何数据,所有内容应该写D盘」；
/// 对默认值的说明是「~/Downloads是默认设置,但是不使用,改用加载配置的D盘设置」。
/// 所以：OS 下载目录只当**名义默认**，解析结果一旦落在禁用盘（`C:`），一律改取
/// D 盘内容根 [`orig_core::paths::content_root`]，并打日志 —— 静默改道等于
/// 用户以为写在 C 盘、其实没有；静默不改道等于把规则当耳边风。
/// 活栈实测：无此规则时装机默认往 `C:\Users\…\Downloads` 积了 30.2 GB。
pub fn effective_download_root(cfg: &Config) -> PathBuf {
    // BUG-323 复报（2026-10-19）：边界真源自己也归一化。解析/保存/下发三段都归一化，
    // 仍留这一处兜底 —— `cfg.download_dir` 还可能由 env（`SURGE_DOWNLOAD_DIR`）或
    // 直接在内存里赋值的路径进来，漏一处就会出现「边界认 A、落点写 B」。
    let raw = cfg
        .download_dir
        .clone()
        .unwrap_or_else(default_download_dir);
    let norm = orig_core::paths::normalize_dir_path(&raw);
    // BUG-355：裸根 `/`、盘符根 `D:/` 与禁用盘同样不可作内容根 —— 一律改取 D 盘内容根，
    // 否则下载落点变成根目录（"/"），所有下载失败且 UI 把 "/" 当生效路径显示（用户复报）。
    if !orig_core::paths::is_valid_content_root(&norm) {
        let redirected = orig_core::paths::content_root();
        tracing::warn!(
            "resolved download root {} is not a valid content root; \
             using {} instead (ruling: all content goes to the D: drive)",
            norm.display(),
            redirected.display()
        );
        return redirected;
    }
    norm
}

/// **受管库根** = `<生效下载路径>/.orighub/library` —— 派生值，**不可独立配置**（BUG-323）。
///
/// 与 orig-tg 侧 `Store::library_root()` 是同一条规则的两端：**必须调同一个派生
/// 函数** `orig_core::paths::library_root_of`，不得各算一套。库根不设独立入口，
/// 是为了让「库根脱离下载路径」在结构上不可表达。
///
/// 2026-10-21「内部文件不入治理」把库根从 `<根>/library` 挪进引擎工作区
/// `.orighub/library`（下载根顶层只留用户内容，成品扫描靠 `.` 前缀结构性排除）。
pub fn library_root(cfg: &Config) -> PathBuf {
    // BUG-356(续)/BUG-357：`effective_download_root` 已归一化为正向斜杠（如
    // `D:/OrigDown`），但 Rust 在 Windows 上对带 `/` 的基路径 `join` 会拼出混合
    // 分隔符（`D:/OrigDown\library`）。下游 `download_dir` / `effective_download_root`
    // / `manual_download_root` 都已走 `normalize_dir_path` 统一成 `/`，唯独库根漏了
    // → 前端「库根」行显示成混合斜杠，且与 orig-tg 侧字符串不一致（边界判定按字符串
    // 比较）。派生后必须再归一化，保证全链路同一字面形态。
    orig_core::paths::normalize_dir_path(&orig_core::paths::library_root_of(
        &effective_download_root(cfg),
    ))
}

/// Three-layer resolution: request dir → config download_dir → platform default
/// directory. A leading `~` in either the request or the config is expanded to
/// the real home directory, so a literal tilde never reaches the filesystem.
/// Only when all three are empty does it fall back to the current directory.
///
/// BUG-323: the third layer is the **platform default download directory**
/// (`~/Downloads`), decoupled from the managed library root (see
/// [`manual_download_root`]).
/// 目录入链前的统一预处理（BUG-323 复报 2026-10-19）：`~` 展开 + 分隔符字面
/// 归一化。请求目录与配置目录都必须过它，否则落点会出现「两条路径同一个目录」。
fn norm_dir_in_chain(d: &str) -> PathBuf {
    orig_core::paths::normalize_dir_path(&orig_core::paths::expand_tilde(d))
}

pub fn resolve_output(req_dir: Option<&str>, cfg: &Config, filename: &str) -> PathBuf {
    // BUG-323 复报（2026-10-19）：请求目录与配置目录都先归一化再拼，
    // 落点字面与「当前生效」行、受管根边界判定保持同一个形态。
    let base = req_dir
        .filter(|s| !s.is_empty())
        .map(norm_dir_in_chain)
        .or_else(|| {
            cfg.download_dir
                .as_deref()
                .map(|d| norm_dir_in_chain(&d.to_string_lossy()))
        })
        .unwrap_or_else(|| manual_download_root(cfg));
    base.join(filename)
}

/// Three-layer resolution + auto classification (R3):
/// - request specifies output_path explicitly → no classification (respect user choice)
/// - `enabled` (request-level classify or config enabled) → archive into a
///   sub-directory derived from the extension
/// - otherwise → identical to [`resolve_output`] (regression)
///
/// A leading `~` in the config download_dir is expanded just like in
/// [`resolve_output`] (BUG-071).
pub fn resolve_output_classified(
    req_dir: Option<&str>,
    cfg: &Config,
    filename: &str,
    enabled: bool,
) -> PathBuf {
    // user explicitly picked a directory: do not classify
    if req_dir.is_some_and(|s| !s.is_empty()) {
        return resolve_output(req_dir, cfg, filename);
    }
    if !enabled {
        return resolve_output(req_dir, cfg, filename);
    }
    let base = cfg
        .download_dir
        .as_deref()
        .map(|d| norm_dir_in_chain(&d.to_string_lossy()))
        .unwrap_or_else(|| manual_download_root(cfg));
    let category = cfg.classify.classify(filename);
    base.join(category).join(filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn cfg_with(classify: ClassifyConfig) -> Config {
        Config { classify, ..Config::default() }
    }

    #[test]
    fn classify_off_unchanged() {
        let cfg = cfg_with(ClassifyConfig::default());
        let p = resolve_output_classified(None, &cfg, "a.mp4", false);
        assert_eq!(
            p.file_name().unwrap().to_str().unwrap(),
            "a.mp4",
            "no classify: filename must match"
        );
    }

    fn parent_name(p: &PathBuf) -> Option<&str> {
        p.parent()
            .and_then(|pp| pp.file_name())
            .and_then(|n| n.to_str())
    }

    #[test]
    fn classify_on_archives() {
        let mut c = ClassifyConfig::default();
        c.enabled = true;
        let cfg = cfg_with(c);
        let p = resolve_output_classified(None, &cfg, "a.zip", true);
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a.zip");
        assert_eq!(parent_name(&p).unwrap(), "Archives");
    }

    #[test]
    fn classify_unknown_others() {
        let mut c = ClassifyConfig::default();
        c.enabled = true;
        let cfg = cfg_with(c);
        let p = resolve_output_classified(None, &cfg, "a.xyzabc", true);
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a.xyzabc");
        assert_eq!(parent_name(&p).unwrap(), "Others");
    }

    #[test]
    fn explicit_dir_no_classify() {
        let mut c = ClassifyConfig::default();
        c.enabled = true;
        let cfg = cfg_with(c);
        let p = resolve_output_classified(Some("D:/tmp"), &cfg, "a.mp4", true);
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a.mp4");
        // parent is the explicit dir, not a category
        assert_eq!(parent_name(&p).unwrap_or("?"), "tmp");
    }

    #[test]
    fn custom_map_overrides() {
        let mut c = ClassifyConfig::default();
        c.enabled = true;
        c.map.insert("pdf".to_string(), "Papers".to_string());
        let cfg = cfg_with(c);
        let p = resolve_output_classified(None, &cfg, "a.pdf", true);
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a.pdf");
        assert_eq!(parent_name(&p).unwrap(), "Papers");
    }

    #[test]
    fn save_classify_roundtrip() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("orig-daemon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download-engine.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"download_dir = \"D:/dl\"\nport = 9999\n\n[classify]\nenabled = true\n[[classify.map]]\next = \"mkv\"\ncategory = \"Films\"\n").unwrap();
        drop(f);

        let cfg = Config::load_from(path.to_str().unwrap());
        assert!(cfg.classify.enabled);
        assert_eq!(cfg.classify.map.get("mkv").map(|s| s.as_str()), Some("Films"));

        // 保存新规则（保留顶层键值）
        let mut map = cfg.classify.map.clone();
        map.insert("mp4".to_string(), "Films".to_string());
        cfg.save_classify_map_to(path.to_str().unwrap(), &map).unwrap();

        let txt = std::fs::read_to_string(&path).unwrap();
        assert!(txt.contains("download_dir = \"D:/dl\""), "top-level key preserved");
        assert!(txt.contains("port = 9999"), "top-level key preserved");
        assert!(txt.contains("ext = \"mkv\""));
        assert!(txt.contains("ext = \"mp4\""));
        // 只允许一个 [classify] 段与一行 enabled（旧段被整体重写而非追加）
        assert_eq!(txt.matches("[classify]").count(), 1);
        assert_eq!(txt.matches("enabled = true").count(), 1);

        // 重新加载验证 roundtrip
        let cfg2 = Config::load_from(path.to_str().unwrap());
        assert_eq!(cfg2.classify.map.get("mp4").map(|s| s.as_str()), Some("Films"));
        assert!(cfg2.classify.enabled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-071 migration: a legacy config that stored `~/Downloads` must resolve
    /// to a real absolute path after upgrading — never `<CWD>/~/Downloads`.
    #[test]
    fn legacy_tilde_config_migrates_to_absolute_path() {
        use std::io::Write;

        let Some(home) = orig_core::paths::home_dir() else {
            return; // no home directory here: expansion is impossible by definition
        };

        let dir = std::env::temp_dir().join(format!("orig-daemon-bug071-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download-engine.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        // Old-style config, exactly what a pre-fix user would have on disk.
        f.write_all(b"download_dir = \"~/Downloads\"\nport = 9876\n").unwrap();
        drop(f);

        let cfg = Config::load_from(path.to_str().unwrap());
        let stored = cfg.download_dir.clone().expect("download_dir must be parsed");
        assert!(
            !stored.to_string_lossy().contains('~'),
            "literal tilde must be expanded, got {}",
            stored.display()
        );
        assert_eq!(stored, home.join("Downloads"), "must expand to the real home dir");
        assert!(stored.is_absolute(), "expanded dir must be absolute: {}", stored.display());

        // The full resolution path must not panic and must stay tilde-free.
        let out = resolve_output(None, &cfg, "a.bin");
        assert_eq!(out, home.join("Downloads").join("a.bin"));
        assert!(
            !out.to_string_lossy().contains('~'),
            "resolved path must not contain a literal tilde: {}",
            out.display()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A request-supplied `~/...` directory must be expanded too (BUG-071).
    #[test]
    fn request_tilde_dir_is_expanded() {
        let Some(home) = orig_core::paths::home_dir() else {
            return;
        };
        let cfg = Config::default();
        let p = resolve_output(Some("~/my-dl"), &cfg, "f.bin");
        assert_eq!(p, home.join("my-dl").join("f.bin"));
        assert!(!p.to_string_lossy().contains('~'));
    }

    /// BUG-323 复报（2026-10-19）：读取侧归一化 —— 活栈实测存量 toml 里存着
    /// `D://OrigDown`（双斜杠），无归一化时界面与引擎从此各算一套。
    #[test]
    fn load_folds_duplicate_separators_bug323() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("orig-daemon-bug323-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download-engine.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"download_dir = \"D://OrigDown\"\n").unwrap();
        drop(f);

        let cfg = Config::load_from(path.to_str().unwrap());
        let stored = cfg.download_dir.expect("download_dir must be parsed");
        assert_eq!(
            stored.to_string_lossy(),
            "D:/OrigDown",
            "读取侧必须折叠重复分隔符（活栈污染形态）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-323 复报（2026-10-19）：保存侧归一化 —— `replace('\\', "/")` 不折叠
    /// 重复分隔符，用户输入的 `D:\\OrigDown` 会被原样写成 `D://OrigDown`。
    #[test]
    fn save_download_dir_folds_duplicate_separators_bug323() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("orig-daemon-bug323s-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download-engine.toml");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"[classify]\nenabled = false\n")
            .unwrap();

        let cfg = Config {
            download_dir: Some(PathBuf::from("D:\\OrigDown\\")),
            ..Config::default()
        };
        cfg.save_download_dir(path.to_str().unwrap()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("download_dir = \"D:/OrigDown\""),
            "保存值必须归一化，实际 = {text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-323 复报（2026-10-19）：请求目录同样归一化（新建下载的落点字面必须与
    /// 「当前生效」行一致，否则用户看到两个路径指向同一个目录）。
    #[test]
    fn resolve_output_folds_request_dir_separator_spelling_bug323() {
        let cfg = Config::default();
        let p = resolve_output(Some("D:\\OrigDown\\"), &cfg, "a.zip");
        assert_eq!(
            p.to_string_lossy().replace('\\', "/"),
            "D:/OrigDown/a.zip",
            "请求目录必须折叠重复分隔符与尾分隔符"
        );
    }

    /// Programmatic configs (e.g. built by tests or sidecars) may still carry a
    /// tilde; the classified path must expand it as well (BUG-071).
    #[test]
    fn classified_tilde_config_is_expanded() {
        let Some(home) = orig_core::paths::home_dir() else {
            return;
        };
        let mut c = ClassifyConfig::default();
        c.enabled = true;
        let cfg = Config {
            download_dir: Some(PathBuf::from("~/Downloads")),
            classify: c,
            ..Config::default()
        };
        let p = resolve_output_classified(None, &cfg, "a.zip", true);
        assert_eq!(p, home.join("Downloads").join("Archives").join("a.zip"));
    }

    /// The platform default directory must be a real path, never a literal tilde.
    #[test]
    fn default_download_dir_has_no_literal_tilde() {
        let d = default_download_dir();
        assert!(!d.as_os_str().is_empty());
        assert!(!d.to_string_lossy().contains('~'), "got {}", d.display());
    }

    // ---- BUG-323：手动下载默认根回退**平台默认**（与库根解耦）----

    fn cfg_with_dirs(download: Option<&str>, library: Option<&str>) -> Config {
        Config {
            download_dir: download.map(PathBuf::from),
            library_dir: library.map(PathBuf::from),
            ..Config::default()
        }
    }

    /// 未配置 `download_dir` + 已配置库根 → 默认根 = **平台默认下载目录**（BUG-323 主断言）。
    ///
    /// C 盘禁用（用户 2026-10-19 裁定「~/Downloads是默认设置,但是不使用」）：本机平台默认
    /// 目录就在 C: 上 ⇒ 默认值不得被采用，落点改取 D 盘内容根。所以这里只能断言
    /// 「要么是平台默认、要么是内容根」，不能无条件断言相等 —— 断言相等等于把
    /// 「不往 C 盘写」当缺陷。
    ///
    /// 反向证伪：若这条断言改回 `<库根>/下载/` 而仍 PASS，说明解耦未生效。
    #[test]
    fn unset_download_dir_falls_back_to_platform_default_bug323() {
        let cfg = cfg_with_dirs(None, Some("D:/lib"));
        let def = default_download_dir();
        let expect = if orig_core::paths::is_forbidden_content_drive(&def) {
            orig_core::paths::content_root()
        } else {
            def.clone()
        };
        let p = resolve_output(None, &cfg, "a.bin");
        assert_eq!(p, expect.join("a.bin"));
        // 库根**不再**参与：即使它被显式配置，默认根也不得落在它下面。
        assert!(
            !p.starts_with("D:/lib"),
            "库根不得再决定默认下载落点，got {}",
            p.display()
        );
        // 分类开启时同样落到 `<默认根>/<分类>/`。
        let p2 = resolve_output_classified(None, &cfg, "a.mp4", true);
        assert_eq!(p2, expect.join("Videos").join("a.mp4"));
    }

    /// 显式配置过 `download_dir` 的**必须尊重** —— 库根不得覆盖它（D23-A 迁移红线）。
    #[test]
    fn explicit_download_dir_is_not_overridden_by_library() {
        let cfg = cfg_with_dirs(Some("D:/mydl"), Some("D:/lib"));
        let p = resolve_output(None, &cfg, "a.bin");
        assert_eq!(p, PathBuf::from("D:/mydl").join("a.bin"));
        // 分类开启时，分类子目录挂在**显式目录**下，而非库根/下载。
        let p2 = resolve_output_classified(None, &cfg, "a.zip", true);
        assert_eq!(p2, PathBuf::from("D:/mydl").join("Archives").join("a.zip"));
    }

    /// 库根也未配置（老库/未初始化）→ 回退平台默认目录（非字面 `~/Downloads`，BUG-071）。
    ///
    /// C 盘禁用（用户 2026-10-19 裁定「~/Downloads是默认设置,但是不使用」）：当平台
    /// 默认目录本身就在禁用盘上时，**默认值不得被采用**，落点改取 D 盘内容根。
    /// 所以这里只能断言「要么是平台默认、要么是 D 盘内容根」，不能断言相等。
    #[test]
    fn manual_download_root_without_library_is_platform_default() {
        let cfg = cfg_with_dirs(None, None);
        let d = default_download_dir();
        if orig_core::paths::is_forbidden_content_drive(&d) {
            assert_eq!(
                manual_download_root(&cfg),
                orig_core::paths::content_root(),
                "默认目录在禁用盘上时，手动下载落点必须改取 D 盘内容根"
            );
        } else {
            assert_eq!(manual_download_root(&cfg), d);
        }
    }

    /// **C 盘禁用（用户 2026-10-19 裁定）**：解析到禁用盘的下载路径一律改取 D 盘
    /// 内容根 —— 无论它是「未配置时的名义默认」还是「用户/env 显式填了 C:」。
    ///
    /// 反向证伪：把 `effective_download_root` 里的改道逻辑删掉 ⇒ 前两条断言转红
    /// （装机默认把内容写进系统盘，正是活栈积了 30.2 GB 的那条路）。
    #[test]
    fn forbidden_drive_root_is_redirected_to_content_root() {
        // ① 未配置：名义默认 `~/Downloads`（本机在 C:）⇒ 改道
        let cfg = cfg_with_dirs(None, None);
        let d = default_download_dir();
        if orig_core::paths::is_forbidden_content_drive(&d) {
            assert_eq!(effective_download_root(&cfg), orig_core::paths::content_root());
            assert_eq!(manual_download_root(&cfg), orig_core::paths::content_root());
        }
        // ② 显式填了 C: ⇒ 同样改道（规则是「不往 C 盘写」，不是尊重填错的配置）
        let cfg = cfg_with_dirs(Some("C:/Users/me/Downloads"), None);
        assert_eq!(
            effective_download_root(&cfg),
            orig_core::paths::content_root(),
            "显式填 C: 也必须改道，否则「不往 C 盘写」可以被一个配置绕开"
        );
        // ③ D: 配置照原样生效（不得被改道改错）
        let cfg = cfg_with_dirs(Some("D:/OrigDown"), None);
        assert_eq!(effective_download_root(&cfg), PathBuf::from("D:/OrigDown"));
        // ④ 库根从属于它（住在引擎工作区 `.orighub/` 下，见 2026-10-21 裁定）
        assert_eq!(
            library_root(&cfg),
            orig_core::paths::library_root_of(Path::new("D:/OrigDown"))
        );
    }

    /// BUG-355：裸根 `/` 与盘符根 `D:/` 不得作为下载根（用户复报：默认下载目录显示 `/`）。
    /// 解析到这类退化值必须改取 D 盘内容根，否则下载落点变成根目录、所有下载失败。
    #[test]
    fn bare_root_download_dir_is_redirected_to_content_root_bug355() {
        // ① 裸 unix 根 "/"
        let cfg = cfg_with_dirs(Some("/"), None);
        assert_eq!(
            effective_download_root(&cfg),
            orig_core::paths::content_root(),
            "裸根 / 必须改道到 D 盘内容根"
        );
        assert_eq!(
            manual_download_root(&cfg),
            orig_core::paths::content_root()
        );
        // ② 盘符根 "D:/"
        let cfg = cfg_with_dirs(Some("D:/"), None);
        assert_eq!(
            effective_download_root(&cfg),
            orig_core::paths::content_root(),
            "盘符根 D:/ 必须改道到 D 盘内容根"
        );
        // ③ 有效路径不受影响
        let cfg = cfg_with_dirs(Some("D:/OrigDown"), None);
        assert_eq!(effective_download_root(&cfg), PathBuf::from("D:/OrigDown"));
    }

    /// 任务显式指定目录时，分类开关与库根都不介入（D16/D23：显式优先、不分类）。
    #[test]
    fn explicit_req_dir_ignores_library_root_and_classify() {
        let cfg = cfg_with_dirs(None, Some("D:/lib"));
        let p = resolve_output_classified(Some("E:/pick"), &cfg, "a.mp4", true);
        assert_eq!(p, PathBuf::from("E:/pick").join("a.mp4"));
    }

    /// BUG-323：库根**派生自下载路径**（`<download_dir>/library`）；历史 `library_dir`
    /// 字段彻底失效（保留解析只为旧 toml 不报错，不参与任何解析结果）。
    ///
    /// C 盘禁用（用户 2026-10-19 裁定）：平台默认目录在 C: 上时，「未配置下载目录」这条
    /// 分支的默认根被改取 D 盘内容根，库根随之派生 —— 不能断言等于平台默认目录/library。
    ///
    /// 反向证伪：把 `library_dir` 指到别处，库根也不得跟着跑 —— 否则
    /// 「库根跟下载走」只是口号。
    #[test]
    fn library_root_derives_from_download_root_bug323() {
        let mut cfg = Config {
            download_dir: None,
            library_dir: None,
            ..Config::default()
        };
        let def = default_download_dir();
        let default_lib = if orig_core::paths::is_forbidden_content_drive(&def) {
            orig_core::paths::library_root_of(&orig_core::paths::content_root())
        } else {
            orig_core::paths::library_root_of(&def)
        };
        assert_eq!(
            library_root(&cfg),
            default_lib,
            "未配置下载目录时库根 = 默认下载根/.orighub/library（默认根过禁用盘规则）"
        );

        cfg.download_dir = Some(PathBuf::from("D:/Videos"));
        assert_eq!(effective_download_root(&cfg), PathBuf::from("D:/Videos"));
        assert_eq!(
            library_root(&cfg),
            orig_core::paths::library_root_of(Path::new("D:/Videos"))
        );

        // 历史字段不得把库根带出下载路径
        cfg.library_dir = Some(PathBuf::from("C:/somewhere/else"));
        assert_eq!(
            library_root(&cfg),
            orig_core::paths::library_root_of(Path::new("D:/Videos")),
            "历史 library_dir 不得影响库根（BUG-323）"
        );
        // BUG-323 复报 4：手动下载落点同样过禁用盘规则（不得回到 C: 的平台默认）
        let manual = manual_download_root(&cfg);
        if orig_core::paths::is_forbidden_content_drive(&default_download_dir()) {
            assert_eq!(manual, orig_core::paths::content_root());
        } else {
            assert_eq!(manual, default_download_dir());
        }
    }

    /// 旧 toml 里的 `library_dir` 仍可被解析（不 panic），但**不参与**任何解析结果。
    #[test]
    fn legacy_library_dir_toml_is_parsed_but_inert_bug323() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("orig-daemon-libdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download-engine.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"download_dir = \"D:/dl\"\nlibrary_dir = \"D:/My Library\"\n")
            .unwrap();
        drop(f);

        let cfg = Config::load_from(path.to_str().unwrap());
        assert_eq!(cfg.library_dir, Some(PathBuf::from("D:/My Library")));
        assert_eq!(
            library_root(&cfg),
            orig_core::paths::library_root_of(Path::new("D:/dl"))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
