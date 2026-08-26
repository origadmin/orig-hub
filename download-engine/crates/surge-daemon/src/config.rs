//! 守护进程配置：下载目录、并发数、鉴权 token、端口、自动分类。
//!
//! 加载顺序（对齐 orig-hub `internal/config` 的「配置存储」语义）：
//!   1. 环境变量（优先，便于容器/CI 覆盖）
//!   2. `download-engine.toml` 简单 `key = "value"` 行 + `[classify]` 段
//!
//! 下载目录三层解析见 [`resolve_output`]：
//!   请求 output_path → 配置 download_dir → 平台默认目录（~/Downloads）

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
    /// 默认并发连接数（对齐 orig-hub `max_connections` 缺省 8）。
    pub max_connections: u32,
    /// Bearer token；为空表示不鉴权（对齐 orig-hub：token 空则不校验）。
    pub token: Option<String>,
    /// 监听端口（对齐 orig-hub daemon 缺省 9876）。
    pub port: u16,
    /// 自动分类配置（R3）。
    pub classify: ClassifyConfig,
    /// HTTP 下载代理配置（默认直连）。
    pub proxy: libsurge::protocol::ProxyConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            download_dir: None,
            max_connections: 8,
            token: None,
            port: 9876,
            classify: ClassifyConfig::default(),
            proxy: libsurge::protocol::ProxyConfig::default(),
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

        if let Ok(d) = std::env::var("SURGE_DOWNLOAD_DIR") {
            if !d.is_empty() {
                cfg.download_dir = Some(PathBuf::from(d));
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

        if let Ok(txt) = std::fs::read_to_string(path) {
            let parser = TomlParser::parse(&txt);

            // 顶层键值
            for (k, v) in &parser.top {
                match k.as_str() {
                    "download_dir" if !v.is_empty() => cfg.download_dir = Some(PathBuf::from(v)),
                    "max_connections" => {
                        if let Ok(n) = v.parse() { cfg.max_connections = n; }
                    }
                    "token" if !v.is_empty() => cfg.token = Some(v.clone()),
                    "port" => {
                        if let Ok(n) = v.parse() { cfg.port = n; }
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
                        "system" => libsurge::protocol::ProxyMode::System,
                        "custom" => libsurge::protocol::ProxyMode::Custom,
                        _ => libsurge::protocol::ProxyMode::Direct,
                    };
                }
                if let Some(v) = sec.get("url") {
                    if !v.is_empty() {
                        cfg.proxy.url = Some(v.clone());
                    }
                }
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
            libsurge::protocol::ProxyMode::Direct => "direct",
            libsurge::protocol::ProxyMode::System => "system",
            libsurge::protocol::ProxyMode::Custom => "custom",
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
}

/// 平台默认下载目录（对齐 orig-hub：~/Downloads）。
pub fn default_download_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Downloads");
    }
    if let Ok(prof) = std::env::var("USERPROFILE") {
        return PathBuf::from(prof).join("Downloads");
    }
    PathBuf::from(".")
}

/// 三层解析：请求 dir → 配置 download_dir → 平台默认目录（~/Downloads）。
/// 仅当三者皆空才落到当前目录（极端兜底）。
pub fn resolve_output(req_dir: Option<&str>, cfg: &Config, filename: &str) -> PathBuf {
    let base = req_dir
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| cfg.download_dir.clone())
        .unwrap_or_else(default_download_dir);
    base.join(filename)
}

/// 三层解析 + 自动分类（R3）：
/// - 请求显式指定 output_path → 不分类（尊重用户选择）
/// - `enabled` 为 true（请求级 classify 或配置开启）→ 在基础目录下按扩展名归档子目录
/// - 否则 → 与 [`resolve_output`] 完全一致（回归）
pub fn resolve_output_classified(
    req_dir: Option<&str>,
    cfg: &Config,
    filename: &str,
    enabled: bool,
) -> PathBuf {
    // 用户显式指定目录：不分类
    if req_dir.is_some_and(|s| !s.is_empty()) {
        return resolve_output(req_dir, cfg, filename);
    }
    if !enabled {
        return resolve_output(req_dir, cfg, filename);
    }
    let base = cfg
        .download_dir
        .clone()
        .unwrap_or_else(default_download_dir);
    let category = cfg.classify.classify(filename);
    base.join(category).join(filename)
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let dir = std::env::temp_dir().join(format!("surge-daemon-test-{}", std::process::id()));
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
}
