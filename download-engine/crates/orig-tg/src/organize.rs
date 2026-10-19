//! **批量整理**（mp3tag 式模板命名 / 归位）—— D24-A / BUG-311。
//!
//! ## 它解决什么
//!
//! 库内改名**不动物理文件**（BUG-310 名实解耦）：`media_item.title` 是显示名，
//! 字节是内容寻址 blob（BUG-309）—— 用户把剧集交给外部播放器 / 分享 / 备份时，
//! 拿到的仍是 `ab/cd/<64hex>` 这种不可读名。本模块提供**受管的批量整理通道**：
//! 按用户模板把 blob 的字节以**硬链接（同卷）/ 副本（跨卷）**铺到用户指定目录，
//! 产出可读名与按剧集组织的目录。
//!
//! ## 三层模型里的位置（09 §15.1）
//!
//! ```text
//! 字节层（blob）      编排层（库）           发布层（整理产物）
//! 内容寻址、只读       series/episode/命名    用户指定目录下的硬链接/副本
//! ```
//!
//! 整理**只写发布层**：blob 本体与引用计数**完全不动**（删产物不影响库内可播性），
//! 产物登记为「外部发布路径」（`media_publish`），**不作为唯一字节来源** ——
//! 外部删了产物，库内播放照旧走 blob，不会死链。
//!
//! ## 红线
//!
//! - **绝不自动改名**：整理是显式用户动作，没有任何自动触发点；
//! - **幂等可重跑**：目标已存在且与源同尺寸 ⇒ 跳过（不重复写、不覆盖）；
//! - **冲突加序号、不静默覆盖**：同批次内重名与磁盘已存在都走 ` (2)`、` (3)`；
//! - **非法字符清洗**：文件名片段里 Windows 非法字符折成 `-`，尾随 `.`/空格剥掉，
//!   `..` 折成 `_`（防路径穿越）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::media::Store;

/// 整理请求（preview 与 apply 共用同一形状）。
///
/// wire 契约 = **camelCase**（与全部兄弟媒体端点一致，见 `AppendEpisodesReq` 等的
/// `rename = "itemIds"`）：前端 `media.ts::organizePreview/Apply` 发的是
/// `{ itemIds, template, targetDir }`。漏 rename 时 preview/apply 对**任何**请求体
/// 都 400（`missing field item_ids`），而单元夹具直调 `plan()/apply()` 不走 wire、
/// 路由层又没有请求体测试 ⇒ 缺陷直达用户才暴露。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRequest {
    /// 要整理的条目 id 集合（前端多选）。
    pub item_ids: Vec<i64>,
    /// mp3tag 式模板，例：`{剧名}/S{season:02}E{episode:02} - {集名}.{ext}`。
    pub template: String,
    /// 产物根目录（用户指定）。
    pub target_dir: String,
}

/// 单条整理结果行（预览全表的一行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRow {
    pub item_id: i64,
    /// 该条目的显名（整理模板可用的 `{集名}` 来源）。
    pub display_name: String,
    /// 源字节绝对路径（blob）。`None` = 该条目无字节，无法整理。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// 目标绝对路径。
    pub target_path: String,
    /// 计划动作：`link`（同卷硬链接）/ `copy`（跨卷副本）/ `skip`（已就位）/
    /// `missing`（无字节）/ `blocked`（目标非法）。
    pub action: String,
    /// 是否因重名而加了序号（预览可见，不静默）。
    pub conflict: bool,
    /// 说明（冲突来源 / 跳过原因 / 非法字符清洗提示）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 预览 / 执行的结果汇总。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeReport {
    pub rows: Vec<OrganizeRow>,
    pub summary: OrganizeSummary,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeSummary {
    pub total: usize,
    pub link: usize,
    pub copy: usize,
    pub skip: usize,
    pub missing: usize,
    pub blocked: usize,
    /// 实际执行时成功写入（link+copy）的条数；preview 恒为 0。
    pub written: usize,
    /// 实际执行时的失败条数；preview 恒为 0。
    pub failed: usize,
}

/// 整理候选（从库里读出的、模板渲染所需的全字段）。
#[derive(Debug, Clone, Default)]
pub struct OrganizeCandidate {
    pub item_id: i64,
    pub title: String,
    pub source_title: Option<String>,
    pub kind: String,
    pub source: String,
    pub added_at: i64,
    /// 库内规范 `file_path`（绝对 blob 路径或相对库根）。
    pub file_path: Option<String>,
    pub series_title: Option<String>,
    pub season: Option<i64>,
    pub episode_no: Option<i64>,
    pub episode_no_end: Option<i64>,
    /// 所属剧集的分集总数（「单集用剧名」判定）。
    pub series_episode_count: Option<i64>,
}

/// 渲染一个模板变量后的取值（用于格式化）。
enum VarValue {
    Text(String),
    Num(i64),
}

impl VarValue {
    fn render(&self, spec: Option<&str>) -> String {
        match self {
            VarValue::Text(s) => s.clone(),
            VarValue::Num(n) => match spec {
                // `{season:02}` → 零填充到**总宽度 2**（mp3tag 风格）。
                //
                // 宽度取 `spec` 的**原长**（含前导零）—— 不能 `trim_start_matches('0')`：
                // 那会把 `02` 削成 `2`（宽 1），于是零填充永不触发，用户拿到 `S1E3`
                // 而不是 `S01E03`，模板里的 `:02` 形同虚设（且**不报错**，最难发现）。
                Some(sp) => {
                    let sp = sp.trim();
                    let width = sp.len().max(1);
                    let zero_pad = sp.starts_with('0');
                    let raw = n.abs().to_string();
                    let padded = if zero_pad && raw.len() < width {
                        format!("{}{}", "0".repeat(width - raw.len()), raw)
                    } else {
                        raw
                    };
                    if *n < 0 { format!("-{padded}") } else { padded }
                }
                None => n.to_string(),
            },
        }
    }
}

/// 扩展名：blob 无扩展名（内容寻址），故按 `kind` 给一个**合理默认**。
///
/// 局限（诚实记录）：源若是 mkv/opus 等非默认容器，这里给不出真容器名 ——
/// 但扩展名只影响外部播放器的关联，不影响字节本身（播放器多按内容嗅探）。
/// 要精确到真容器，需在入库时记下原始扩展名（后续里程碑可补列）。
fn ext_for_kind(kind: &str) -> &'static str {
    match kind {
        "video" => "mp4",
        "audio" => "mp3",
        "photo" => "jpg",
        _ => "bin",
    }
}

/// 把模板变量名归一（中英别名）。
fn var_value(
    name: &str,
    cand: &OrganizeCandidate,
    display_name: &str,
) -> Option<VarValue> {
    match name {
        "剧名" | "series" | "series_title" | "seriesTitle" => cand
            .series_title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(VarValue::Text),
        "季" | "season" => cand.season.map(VarValue::Num),
        "集" | "集号" | "episode" | "ep" | "episode_no" | "episodeNo" => {
            cand.episode_no.map(VarValue::Num)
        }
        "集名" | "标题" | "title" | "episode_title" | "episodeTitle" => {
            let t = display_name.trim();
            if t.is_empty() {
                None
            } else {
                Some(VarValue::Text(t.to_string()))
            }
        }
        "来源原文" | "source_title" | "sourceTitle" => cand
            .source_title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(VarValue::Text),
        "来源" | "source" => Some(VarValue::Text(cand.source.clone())),
        "日期" | "date" => Some(VarValue::Text(fmt_date(cand.added_at))),
        "扩展名" | "ext" => Some(VarValue::Text(ext_for_kind(&cand.kind).to_string())),
        _ => None,
    }
}

/// `added_at`（unix 秒）→ `YYYY-MM-DD`（本地无关的 UTC 日期，避免时区漂移）。
fn fmt_date(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let (y, m, d) = ymd_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn ymd_from_days(days: i64) -> (i64, i64, i64) {
    // Howard Hinnant 算法（与 media.rs 的导出时间戳同源，避免引入 chrono）。
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let (m, y_adj) = if mp < 10 { (mp + 3, 0) } else { (mp - 9, 1) };
    (y + y_adj, m, d)
}

/// 清洗单个路径片段：Windows 非法字符折成 `-`，控制字符丢弃，尾随 `.`/空格剥掉，
/// `..` 折成 `_`（防穿越）。空结果返回 `_`。
fn sanitize_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for c in seg.chars() {
        if c.is_control() {
            continue;
        }
        if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('-');
        } else {
            out.push(c);
        }
    }
    // 折叠连续 '-'（清洗产生的噪声）
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let trimmed = out.trim().trim_end_matches('.').trim();
    let cleaned = if trimmed == ".." || trimmed == "." {
        "_"
    } else {
        trimmed
    };
    if cleaned.is_empty() {
        "_".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 渲染模板 → 相对路径（已逐段清洗）。未知变量渲染为空串（不报错：模板是用户输入，
/// 未知变量当作「不填」比整批失败友好）。
pub fn render_template(template: &str, cand: &OrganizeCandidate, display_name: &str) -> String {
    let mut out = String::new();
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '{' {
            out.push(c);
            continue;
        }
        // 收集到 '}'
        let mut token = String::new();
        let mut closed = false;
        for c2 in chars.by_ref() {
            if c2 == '}' {
                closed = true;
                break;
            }
            token.push(c2);
        }
        if !closed {
            // 未闭合的 '{' 原样输出
            out.push('{');
            out.push_str(&token);
            continue;
        }
        let (name, spec) = match token.split_once(':') {
            Some((n, s)) => (n.trim(), Some(s)),
            None => (token.trim(), None),
        };
        if let Some(v) = var_value(name, cand, display_name) {
            out.push_str(&v.render(spec));
        }
        // 未知变量 → 空串
    }
    // 逐段清洗（保留分隔符）
    let parts: Vec<String> = out
        .split(['/', '\\'])
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_segment)
        .collect();
    if parts.is_empty() {
        format!("item-{}", cand.item_id)
    } else {
        parts.join("/")
    }
}

/// 在文件名（最后一段）加序号：`a.mp4` → `a (2).mp4`。
fn with_ordinal(rel: &str, n: usize) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, rel),
    };
    let suffixed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{file} ({n})"),
    };
    match dir {
        Some(d) => format!("{d}/{suffixed}"),
        None => suffixed,
    }
}

/// 生成整理计划（**只读**，不碰磁盘）：逐条渲染目标路径、去重加序号、判动作。
///
/// `dry_run = true` 时 `action` 只是**预测**（link/copy/skip/missing/blocked），
/// 不写任何文件；`dry_run = false` 时在计划之上真正执行并回填 `written/failed`。
pub async fn plan(
    store: &Store,
    req: &OrganizeRequest,
) -> Result<OrganizeReport, String> {
    if req.target_dir.trim().is_empty() {
        return Err("targetDir is empty".to_string());
    }
    let lib_root: PathBuf = store.library_root().await;
    let target_root = PathBuf::from(req.target_dir.trim());
    let cands = store
        .organize_candidates(&req.item_ids)
        .await
        .map_err(|e| format!("db error: {e}"))?;
    // 显名：复用引擎侧的显名规则（自定义集名 > 剧名+集号 > 来源原文）。
    let display_of = |c: &OrganizeCandidate| -> String {
        crate::media::resolve_display_name(
            &c.title,
            c.source_title.as_deref(),
            c.series_title.as_deref(),
            c.season,
            c.episode_no,
            c.episode_no_end,
            c.series_episode_count,
        )
    };

    // 目标相对路径（去重前）
    let mut planned: Vec<(OrganizeCandidate, String, String)> = Vec::new();
    for c in cands {
        let dn = display_of(&c);
        let rel = render_template(&req.template, &c, &dn);
        planned.push((c, dn, rel));
    }

    // 同批次内去重：重复的相对路径加序号。
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut rows: Vec<OrganizeRow> = Vec::new();
    for (c, dn, rel0) in planned {
        let mut rel = rel0.clone();
        let mut conflict = false;
        if let Some(count) = seen.get_mut(&rel) {
            *count += 1;
            rel = with_ordinal(&rel0, *count);
            conflict = true;
        } else {
            seen.insert(rel.clone(), 1);
        }
        let target = target_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let source_abs = c
            .file_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .map(|p| crate::cache::resolve_item_path(&lib_root, p));

        let (action, note) = match &source_abs {
            None => ("missing".to_string(), Some("no local bytes".to_string())),
            Some(src) => {
                if !src.exists() {
                    ("missing".to_string(), Some("source file missing on disk".to_string()))
                } else if target.exists() {
                    // 幂等：目标已存在且尺寸相同 ⇒ 视为已就位（跳过）。
                    let same = match (std::fs::metadata(src), std::fs::metadata(&target)) {
                        (Ok(a), Ok(b)) => a.len() == b.len(),
                        _ => false,
                    };
                    if same {
                        ("skip".to_string(), Some("already organized".to_string()))
                    } else {
                        // 尺寸不同 ⇒ 不覆盖，加序号另存（下一条会因 `seen` 顺延；
                        // 这里就地再找一个空位，避免每次重跑都撞同一个名字）。
                        ("link".to_string(), Some("target exists, will use next free name".to_string()))
                    }
                } else {
                    ("link".to_string(), None)
                }
            }
        };
        rows.push(OrganizeRow {
            item_id: c.item_id,
            display_name: dn,
            source_path: source_abs.map(|p| p.to_string_lossy().into_owned()),
            target_path: target.to_string_lossy().into_owned(),
            action,
            conflict,
            note,
        });
    }

    let summary = summarize(&rows, 0, 0);
    Ok(OrganizeReport { rows, summary })
}

fn summarize(rows: &[OrganizeRow], written: usize, failed: usize) -> OrganizeSummary {
    let mut s = OrganizeSummary {
        total: rows.len(),
        written,
        failed,
        ..Default::default()
    };
    for r in rows {
        match r.action.as_str() {
            "link" => s.link += 1,
            "copy" => s.copy += 1,
            "skip" => s.skip += 1,
            "missing" => s.missing += 1,
            "blocked" => s.blocked += 1,
            _ => {}
        }
    }
    s
}

/// 执行整理：按 `plan` 逐条落盘（同卷硬链接 / 跨卷副本），并登记发布路径。
///
/// 返回执行后的报告（`action` 回填为实际结果，`summary.written/failed` 为实测计数）。
pub async fn apply(
    store: &Store,
    req: &OrganizeRequest,
) -> Result<OrganizeReport, String> {
    let mut report = plan(store, req).await?;
    let target_root = PathBuf::from(req.target_dir.trim());
    let mut written = 0usize;
    let mut failed = 0usize;

    for row in report.rows.iter_mut() {
        match row.action.as_str() {
            "link" | "copy" => {}
            _ => continue,
        }
        let Some(src) = row.source_path.clone() else {
            row.action = "missing".to_string();
            failed += 1;
            continue;
        };
        let mut target = PathBuf::from(&row.target_path);
        // 目标已存在且尺寸不同 ⇒ 找下一个空位（不覆盖）。
        if target.exists() {
            if let Ok(bm) = std::fs::metadata(&target) {
                if let Ok(sm) = std::fs::metadata(&src) {
                    if bm.len() == sm.len() {
                        row.action = "skip".to_string();
                        continue;
                    }
                }
            }
            let mut n = 2usize;
            let rel = target
                .strip_prefix(&target_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| row.target_path.clone());
            loop {
                let cand = target_root.join(with_ordinal(&rel, n).replace('/', std::path::MAIN_SEPARATOR_STR));
                if !cand.exists() {
                    target = cand;
                    break;
                }
                n += 1;
                if n > 9999 {
                    break;
                }
            }
            row.conflict = true;
        }
        if let Some(parent) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                row.action = "blocked".to_string();
                row.note = Some(format!("mkdir failed: {e}"));
                failed += 1;
                continue;
            }
        }
        // 先试硬链接（同卷、零拷贝）；跨卷 / 不支持 → 回退副本。
        let mode = match std::fs::hard_link(&src, &target) {
            Ok(()) => {
                row.action = "link".to_string();
                "hardlink"
            }
            Err(link_err) => match std::fs::copy(&src, &target) {
                Ok(_) => {
                    row.action = "copy".to_string();
                    row.note = Some(format!("hardlink unavailable ({link_err}); copied"));
                    "copy"
                }
                Err(copy_err) => {
                    row.action = "blocked".to_string();
                    row.note = Some(format!("write failed: {copy_err}"));
                    failed += 1;
                    continue;
                }
            },
        };
        row.target_path = target.to_string_lossy().into_owned();
        written += 1;
        // 登记「外部发布路径」—— 只作记录，不是字节唯一来源（外部删了不死链）。
        if let Err(e) = store
            .record_publish(row.item_id, &row.target_path, mode)
            .await
        {
            // 登记失败不阻断整理（字节已落盘）；留痕。
            row.note = Some(format!(
                "{}; publish record failed: {e}",
                row.note.clone().unwrap_or_default()
            ));
        }
    }

    report.summary = summarize(&report.rows, written, failed);
    Ok(report)
}

/// 模板预设（前端「模板」下拉用；也便于验收脚本断言稳定形状）。
pub fn preset_templates() -> Vec<serde_json::Value> {
    use serde_json::json;
    vec![
        json!({
            "id": "series-se",
            "template": "{剧名}/S{season:02}E{episode:02} - {集名}.{ext}",
            "label": "剧名/S01E01 - 集名.ext"
        }),
        json!({
            "id": "series-only",
            "template": "{剧名}/S{season:02}E{episode:02}.{ext}",
            "label": "剧名/S01E01.ext"
        }),
        json!({
            "id": "flat-title",
            "template": "{集名}.{ext}",
            "label": "集名.ext"
        }),
        json!({
            "id": "date-source",
            "template": "{日期}_{来源}_{集名}.{ext}",
            "label": "日期_来源_集名.ext"
        }),
    ]
}

/// 目标目录是否可写（预览时给前端一个前置校验，避免用户白填）。
pub fn target_dir_writable(dir: &Path) -> bool {
    if dir.as_os_str().is_empty() {
        return false;
    }
    if dir.exists() {
        return dir.is_dir();
    }
    // 不存在：看最近的存在祖先能否建子目录。
    let mut cur = dir;
    while let Some(parent) = cur.parent() {
        if parent.exists() {
            return parent.is_dir();
        }
        cur = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand() -> OrganizeCandidate {
        OrganizeCandidate {
            item_id: 7,
            title: "第三集 夜航".into(),
            source_title: Some("第三集 夜航".into()),
            kind: "video".into(),
            source: "tg".into(),
            added_at: 0,
            file_path: Some("blobs/ab/cd/deadbeef".into()),
            series_title: Some("星际漫游".into()),
            season: Some(1),
            episode_no: Some(3),
            episode_no_end: None,
            series_episode_count: Some(12),
        }
    }

    #[test]
    fn template_renders_chinese_and_format_specs() {
        let c = cand();
        let out = render_template("{剧名}/S{season:02}E{episode:02} - {集名}.{ext}", &c, "第三集 夜航");
        assert_eq!(out, "星际漫游/S01E03 - 第三集 夜航.mp4");
    }

    /// wire 契约夹具（M2-T09 验收发现）：`OrganizeRequest` 必须收 **camelCase**
    /// —— 前端 `api/media.ts::organizePreview` 发的是 `JSON.stringify({
    /// itemIds, template, targetDir })`。曾漏 `rename_all` ⇒ 路由层对任何请求体
    /// 都 `400 missing field item_ids`（夹具直调 `plan()` 不走 wire，抓不到）。
    /// 本测试还原述求体的**原文字节**（不是 Rust 构造），漏 rename 即 FAIL。
    #[test]
    fn organize_request_accepts_camel_case_wire_bug311() {
        let body = r#"{"itemIds":[3,1,2],"template":"{集名}.{ext}","targetDir":"D:/out"}"#;
        let req: OrganizeRequest = serde_json::from_str(body).expect("camelCase body must deserialize");
        assert_eq!(req.item_ids, vec![3, 1, 2]);
        assert_eq!(req.template, "{集名}.{ext}");
        assert_eq!(req.target_dir, "D:/out");
    }

    /// 反向证伪：snake_case 请求体必须**失败** —— 证明契约是「唯一 camelCase」，
    /// 而不是「两种都收」（都收会让上面的夹具在 rename 丢失时假绿）。
    /// serde 的报错用 **rename 后**的字段名（`itemIds`），不是 Rust 字段名。
    #[test]
    fn snake_case_wire_is_rejected_bug311() {
        let body = r#"{"item_ids":[1],"template":"{集名}.{ext}","target_dir":"D:/out"}"#;
        let err = serde_json::from_str::<OrganizeRequest>(body)
            .expect_err("snake_case body must not deserialize");
        let msg = err.to_string();
        assert!(
            msg.contains("itemIds"),
            "error should name the wire-level missing field (itemIds), got: {msg}"
        );
    }

    #[test]
    fn unknown_variable_renders_empty_not_error() {
        let c = cand();
        let out = render_template("{nope}/{集名}.{ext}", &c, "第三集 夜航");
        assert_eq!(out, "第三集 夜航.mp4");
    }

    #[test]
    fn illegal_characters_are_sanitized() {
        let mut c = cand();
        c.series_title = Some("a/b:c*?".into());
        let out = render_template("{剧名}/{集名}.{ext}", &c, "x");
        // 斜杠是分隔符（会拆段），其余非法字符折成 '-'
        assert!(!out.contains(':') && !out.contains('*') && !out.contains('?'));
    }

    #[test]
    fn ordinal_appends_before_extension() {
        assert_eq!(with_ordinal("d/a.mp4", 2), "d/a (2).mp4");
        assert_eq!(with_ordinal("a", 3), "a (3)");
    }

    #[test]
    fn extension_defaults_by_kind() {
        assert_eq!(ext_for_kind("video"), "mp4");
        assert_eq!(ext_for_kind("audio"), "mp3");
        assert_eq!(ext_for_kind("photo"), "jpg");
        assert_eq!(ext_for_kind("file"), "bin");
    }

    // ─────────── 端到端（真实 DB + 真实磁盘）── D24-A / BUG-311 ───────────

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // 2026-10-19：夹具必须落在**非禁用盘**（`store::fixture_base`）—— 本组用例把
        // 夹具根钉成下载根（库根/`.blobs` 都派生自它），而下载根解析到 C: 会被改道到
        // 真实内容根 `D:\OrigDown`，整理动作会直接搬动用户真实文件。
        let d = crate::store::fixture_base(&format!("organize-{tag}-{seq}"));
        d
    }

    /// 建一条「真字节 + blob 路径」的条目：文件落在 `.blobs/<hash>` 下，
    /// `file_path` 指向它（内容寻址的库内规范形式 = 绝对路径）。
    async fn seed_item_with_blob(
        s: &crate::media::Store,
        lib: &Path,
        name: &str,
        hash: &str,
        bytes: usize,
        series_id: Option<i64>,
        season: i64,
        episode_no: i64,
    ) -> i64 {
        let blob = lib.join(".blobs").join(&hash[0..2]).join(&hash[2..4]).join(hash);
        std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
        std::fs::write(&blob, vec![b'x'; bytes]).unwrap();
        s.upsert_media_item("tg", &format!("-100:{name}"), name, "video", None, Some(bytes as i64), None, None)
            .await
            .unwrap();
        let id = s.item_id_by_ref("tg", &format!("-100:{name}")).await.unwrap().unwrap();
        s.backfill_item_bytes_with_blob(id, blob.to_str().unwrap(), None, hash, bytes as i64)
            .await
            .unwrap();
        if let Some(sid) = series_id {
            s.add_episode(sid, id, season, episode_no).await.unwrap();
        }
        id
    }

    /// 整理会把字节搬成**硬链接 / 副本**到目标目录，但 **blob 本体必须原样留着**、
    /// `media_item.file_path` 不得被改成产物路径（播放永远以 blob 为准，BUG-311 红线）。
    ///
    /// 反向证伪：若 `apply` 顺手更新了 `file_path`，`same` 断言当场 FAIL。
    #[tokio::test]
    async fn organize_never_touches_the_blob_or_the_item_path_bug311() {
        let lib = tmp_root("apply");
        let db_path = lib.join("store.db");
        let s = crate::media::Store::open(&db_path).await.unwrap();
        // BUG-323：库根派生自下载根（`<下载根>/library`），独立的 `library_dir`
        // 已无写入口；本组用例的 db 与 `.blobs` 都落在 `lib` 下 ⇒ 把 `lib` 钉为
        // **下载根**，字节区整体仍在受管路径内。
        s.set_setting("download_dir", lib.to_str().unwrap()).await.unwrap();
        let hash = "aa".repeat(32);
        let id = seed_item_with_blob(&s, &lib, "e1", &hash, 64, None, 1, 1).await;
        let target = tmp_root("apply_out");

        let req = OrganizeRequest {
            item_ids: vec![id],
            template: "{集名}.{ext}".into(),
            target_dir: target.to_str().unwrap().into(),
        };
        // 预览：只读、不落盘
        let pre = plan(&s, &req).await.unwrap();
        assert_eq!(pre.rows.len(), 1);
        assert_eq!(pre.rows[0].action, "link", "磁盘上还没有产物 ⇒ 走 link");
        assert_eq!(pre.summary.link, 1, "预览即报 1 条计划 link");
        assert!(!target.join("e1.mp4").exists(), "预览**不得**落盘");

        // 执行
        let rep = apply(&s, &req).await.unwrap();
        assert_eq!(rep.summary.written, 1, "执行后 written = 1");
        assert_eq!(rep.summary.failed, 0);
        let out = target.join("e1.mp4");
        assert!(out.exists(), "产物已生成");
        assert_eq!(std::fs::metadata(&out).unwrap().len(), 64, "产物字节完整");

        // 红线：blob 本体 + file_path 都没动
        let blob = lib.join(".blobs").join("aa").join("aa").join(&hash);
        assert!(blob.exists(), "整理**绝不**回收 blob 字节");
        let item = s.get_media_item(id).await.unwrap().unwrap();
        assert_eq!(
            item.file_path.as_deref(),
            blob.to_str(),
            "file_path 仍指向 blob，不是整理产物"
        );
        // 发布路径已登记
        let published = s.list_publish(id).await.unwrap();
        assert_eq!(published, vec![out.to_str().unwrap().to_string()]);
    }

    /// 幂等：同一请求重跑第二次 = 全部 `skip`、不重复写、不覆盖既有产物。
    #[tokio::test]
    async fn organize_is_idempotent_on_rerun_bug311() {
        let lib = tmp_root("idem");
        let s = crate::media::Store::open(lib.join("store.db")).await.unwrap();
        // BUG-323：库根派生自下载根（`<下载根>/library`），独立的 `library_dir`
        // 已无写入口；本组用例的 db 与 `.blobs` 都落在 `lib` 下 ⇒ 把 `lib` 钉为
        // **下载根**，字节区整体仍在受管路径内。
        s.set_setting("download_dir", lib.to_str().unwrap()).await.unwrap();
        let id = seed_item_with_blob(&s, &lib, "e1", &"bb".repeat(32), 32, None, 1, 1).await;
        let target = tmp_root("idem_out");
        let req = OrganizeRequest {
            item_ids: vec![id],
            template: "{集名}.{ext}".into(),
            target_dir: target.to_str().unwrap().into(),
        };
        let first = apply(&s, &req).await.unwrap();
        assert_eq!(first.summary.written, 1);

        // 第二次：目标已存在且尺寸相同 ⇒ skip
        let second = apply(&s, &req).await.unwrap();
        assert_eq!(second.summary.skip, 1, "重跑必须全部跳过");
        assert_eq!(second.summary.written, 0, "重跑不得重复写");
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1, "不得留下第二个副本");
    }

    /// 同批次内两条落到同一相对路径 ⇒ 第二条加序号，**绝不静默覆盖**第一条。
    ///
    /// 场景选「**两个同名剧集**」（不是同一剧的同槽两条）—— 后者撞的是
    /// `media_episode UNIQUE(series_id, season, episode_no)`，插入时就被后端对调/替换，
    /// 根本到不了整理层（那是夹具错，不是产品缺陷）。同名剧集才是整理的真实冲突源：
    /// 两个不同来源各自的「星际漫游」都渲染出 `星际漫游/S01E01.mp4`。
    #[tokio::test]
    async fn organize_adds_ordinal_on_same_batch_collision_bug311() {
        let lib = tmp_root("collide");
        let s = crate::media::Store::open(lib.join("store.db")).await.unwrap();
        // BUG-323：库根派生自下载根（`<下载根>/library`），独立的 `library_dir`
        // 已无写入口；本组用例的 db 与 `.blobs` 都落在 `lib` 下 ⇒ 把 `lib` 钉为
        // **下载根**，字节区整体仍在受管路径内。
        s.set_setting("download_dir", lib.to_str().unwrap()).await.unwrap();
        let sid1 = s.create_series("同名剧", None, "series", None, None).await.unwrap();
        let sid2 = s.create_series("同名剧", None, "series", None, None).await.unwrap();
        let a = seed_item_with_blob(&s, &lib, "a", &"cc".repeat(32), 10, Some(sid1), 1, 1).await;
        let b = seed_item_with_blob(&s, &lib, "b", &"dd".repeat(32), 20, Some(sid2), 1, 1).await;
        let target = tmp_root("collide_out");
        let req = OrganizeRequest {
            item_ids: vec![a, b],
            template: "{剧名}/S{season:02}E{episode:02}.{ext}".into(),
            target_dir: target.to_str().unwrap().into(),
        };
        let pre = plan(&s, &req).await.unwrap();
        let paths: Vec<&str> = pre.rows.iter().map(|r| r.target_path.as_str()).collect();
        assert_eq!(pre.rows.len(), 2);
        assert_ne!(paths[0], paths[1], "同批次重名必须分 path");
        assert!(
            paths[1].contains("(2)"),
            "第二条必须加序号，不得指向第一条的路径: {paths:?}"
        );
        assert!(pre.rows[1].conflict, "冲突必须如实标记（不静默）");

        let rep = apply(&s, &req).await.unwrap();
        assert_eq!(rep.summary.written, 2, "两条都要落");
        assert_eq!(rep.summary.failed, 0);
        assert_eq!(std::fs::read_dir(&target.join("同名剧")).unwrap().count(), 2);
    }

    /// 无字节条目必须报 `missing`，不得凭空产出空文件。
    #[tokio::test]
    async fn organize_reports_missing_for_items_without_bytes_bug311() {
        let lib = tmp_root("missing");
        let s = crate::media::Store::open(lib.join("store.db")).await.unwrap();
        // BUG-323：库根派生自下载根（`<下载根>/library`），独立的 `library_dir`
        // 已无写入口；本组用例的 db 与 `.blobs` 都落在 `lib` 下 ⇒ 把 `lib` 钉为
        // **下载根**，字节区整体仍在受管路径内。
        s.set_setting("download_dir", lib.to_str().unwrap()).await.unwrap();
        s.upsert_media_item("tg", "-100:noblob", "无字节", "video", None, None, None, None)
            .await
            .unwrap();
        let id = s.item_id_by_ref("tg", "-100:noblob").await.unwrap().unwrap();
        let target = tmp_root("missing_out");
        let req = OrganizeRequest {
            item_ids: vec![id],
            template: "{集名}.{ext}".into(),
            target_dir: target.to_str().unwrap().into(),
        };
        let rep = apply(&s, &req).await.unwrap();
        assert_eq!(rep.summary.missing, 1, "无字节 ⇒ missing");
        assert_eq!(rep.summary.written, 0, "无字节绝不能写成空文件");
        assert!(!target.join("无字节.mp4").exists());
    }
}
