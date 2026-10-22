//! 引擎下载任务的本地持久化（BUG-319）。
//!
//! 为什么必须落库：daemon 的下载任务表以前是**纯内存**的
//! `HashMap<String, DownloadTask>`（`state.rs` 的 `AppState::tasks`）。
//! 进程一没 —— 崩溃、被更新覆盖、或像 BUG-321 那样整树被控制台关闭带走 ——
//! 全部下载行连同状态一起消失，用户看到的就是「全部下载数据丢失」。
//! 而栈被监督者拉回来之后，栈是活的、行是空的：界面上的「没有数据」是假象。
//!
//! 与 orig-tg 侧 `cache_task` 的边界：那一侧是 TG 缓存任务，这一侧是普通 HTTP
//! 下载任务；两边**同后端不同表**（本表 `engine_task`），互不读写。
//! 采用与 orig-tg 相同的 libsql 本地后端（`core` feature），避免与 bundled
//! sqlite3 的 LNK2005 多重定义链接冲突。
//!
//! 语义三律（决定落什么、什么时候落）：
//! 1. **登记与传输分离**：任务一入队就落库（哪怕一个字节都还没下），
//!    与媒体库「先登记、字节异步补齐」同源；
//! 2. **状态变更才写**：进度是高频的（每轮询几百毫秒一次），逐次落盘会把
//!    日志/DB 变成 IO 热点，违背「不影响下载性能」；只有状态迁移
//!    （入队/暂停/继续/取消/完成/失败）与终态字节数才写；
//! 3. **终态也保留**：取消与失败行不删 —— 用户要的是「记录还在」，
//!    删除是用户显式动作（`DELETE /api/downloads/:id`）才发生的。

use std::path::{Path, PathBuf};

use libsql::{params, Connection, Row};

/// 正在下载。
pub const ST_DOWNLOADING: &str = "downloading";
/// 用户暂停。
pub const ST_PAUSED: &str = "paused";
/// 已完成。
pub const ST_COMPLETED: &str = "completed";
/// 用户取消。
pub const ST_CANCELLED: &str = "cancelled";
/// 下载失败（含探测失败、IO 失败）。
pub const ST_ERROR: &str = "error";
/// 进程消失时仍在跑 ⇒ 下次启动被改写成它，与 orig-tg 的 `interrupted` 同名同义。
pub const ST_INTERRUPTED: &str = "interrupted";

/// 一条引擎下载任务的持久化记录（`engine_task` 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineTaskRecord {
    pub id: String,
    pub url: String,
    pub filename: String,
    /// 落盘绝对路径（字符串存库；路径非法也不该让持久化失败）。
    pub output: String,
    pub added_at: i64,
    pub updated_at: i64,
    pub max_concurrency: u32,
    pub category: Option<String>,
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// 引擎任务库（`<数据目录>/engine_tasks.db`）。
pub struct TaskStore {
    conn: Connection,
}

impl TaskStore {
    /// 打开（不存在则创建）并建表。
    ///
    /// **失败一律返回 `None`，绝不阻断 daemon 启动**：持久化是可用性增强，
    /// 不是服务前提 —— 磁盘满、目录只读时下载照样能跑，只是记录会丢。
    /// 这条容错口径与 `state.rs` 的 `open_log_file`（日志不能让主流程失败）一致。
    pub async fn open(data_dir: &Path) -> Option<Self> {
        let path = db_path(data_dir);
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("[engine-store] cannot create {}: {e}", parent.display());
                return None;
            }
        }
        let conn = match libsql::Builder::new_local(&path).build().await {
            Ok(db) => match db.connect() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[engine-store] connect {} failed: {e}", path.display());
                    return None;
                }
            },
            Err(e) => {
                eprintln!("[engine-store] open {} failed: {e}", path.display());
                return None;
            }
        };
        if let Err(e) = conn
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS engine_task (
                    id              TEXT PRIMARY KEY,
                    url             TEXT NOT NULL,
                    filename        TEXT NOT NULL,
                    output          TEXT NOT NULL,
                    added_at        INTEGER NOT NULL,
                    updated_at      INTEGER NOT NULL,
                    max_concurrency INTEGER NOT NULL DEFAULT 1,
                    category       TEXT,
                    status          TEXT NOT NULL,
                    downloaded      INTEGER NOT NULL DEFAULT 0,
                    total           INTEGER NOT NULL DEFAULT 0,
                    error           TEXT
                );
                "#,
            )
            .await
        {
            eprintln!("[engine-store] migrate failed: {e}");
            return None;
        }
        Some(Self { conn })
    }

    /// 写入 / 更新一条记录（按 id 幂等）。
    pub async fn upsert(&self, r: &EngineTaskRecord) {
        let res = self
            .conn
            .execute(
                "INSERT INTO engine_task
                 (id, url, filename, output, added_at, updated_at, max_concurrency,
                  category, status, downloaded, total, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   url = excluded.url,
                   filename = excluded.filename,
                   output = excluded.output,
                   updated_at = excluded.updated_at,
                   max_concurrency = excluded.max_concurrency,
                   category = excluded.category,
                   status = excluded.status,
                   downloaded = excluded.downloaded,
                   total = excluded.total,
                   error = excluded.error",
                params![
                    r.id.clone(),
                    r.url.clone(),
                    r.filename.clone(),
                    r.output.clone(),
                    r.added_at,
                    r.updated_at,
                    r.max_concurrency as i64,
                    r.category.clone(),
                    r.status.clone(),
                    r.downloaded as i64,
                    r.total as i64,
                    r.error.clone(),
                ],
            )
            .await;
        if let Err(e) = res {
            eprintln!("[engine-store] upsert {} failed: {e}", r.id);
        }
    }

    /// 只改状态（不碰字节数）。
    ///
    /// 状态迁移（暂停/继续/取消）走这里，而不是整条 upsert：进度字节是**终态**
    /// 才写的值，若每次暂停都用默认值覆盖一遍，「暂停一下再看，进度变 0 了」
    /// 就会成为新的一类假象。
    pub async fn set_status(&self, id: &str, status: &str) {
        let res = self
            .conn
            .execute(
                "UPDATE engine_task SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status.to_string(), now_secs(), id.to_string()],
            )
            .await;
        if let Err(e) = res {
            eprintln!("[engine-store] set status {id} -> {status} failed: {e}");
        }
    }

    /// 删除一条记录（用户显式删除任务时）。
    pub async fn remove(&self, id: &str) {
        if let Err(e) = self
            .conn
            .execute("DELETE FROM engine_task WHERE id = ?1", params![id.to_string()])
            .await
        {
            eprintln!("[engine-store] delete {id} failed: {e}");
        }
    }

    /// 全部记录（按入队时间正序）。
    pub async fn all(&self) -> Vec<EngineTaskRecord> {
        self.query_all("SELECT id, url, filename, output, added_at, updated_at, max_concurrency, \
                        category, status, downloaded, total, error \
                        FROM engine_task ORDER BY added_at")
            .await
    }

    /// 按 id 取一条记录（`None` = 库里没有）。
    ///
    /// 参数化查询而非字符串拼接：id 来自 URL 路径，拼进 SQL 就是把外部输入
    /// 当 SQL 执行。
    pub async fn get(&self, id: &str) -> Option<EngineTaskRecord> {
        let stmt = match self
            .conn
            .prepare(
                "SELECT id, url, filename, output, added_at, updated_at, max_concurrency, \
                 category, status, downloaded, total, error \
                 FROM engine_task WHERE id = ?1",
            )
            .await
        {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[engine-store] prepare failed: {e}");
                return None;
            }
        };
        let mut rows = match stmt.query(params![id.to_string()]).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[engine-store] query failed: {e}");
                return None;
            }
        };
        match rows.next().await {
            Ok(Some(r)) => record_from_row(&r),
            Ok(None) => None,
            Err(e) => {
                eprintln!("[engine-store] row failed: {e}");
                None
            }
        }
    }

    /// 未完成记录（进程活着时就是内存里那些；进程没了就只剩库里这些）。
    pub async fn unfinished(&self) -> Vec<EngineTaskRecord> {
        self.query_all(
            "SELECT id, url, filename, output, added_at, updated_at, max_concurrency, \
             category, status, downloaded, total, error \
             FROM engine_task WHERE status IN ('downloading', 'paused') ORDER BY added_at",
        )
        .await
    }

    /// 启动恢复的第一步：把上次进程留下的「还在跑」全部改写成 `interrupted`，
    /// 并把它们交给调用方去决定是否重新入队。
    ///
    /// 为什么必须先改写而不是直接删 / 直接当下载中：
    /// - 直接删 = BUG-319 原样（数据没了）；
    /// - 当下载中 = 撒谎（此刻没有任何 worker 在跑，这是「已开启但未连接」的同型假象）；
    /// - 改写成 `interrupted` 后，即使后续重新入队**失败**（URL 探测不通、源站已失效），
    ///   这条记录也仍然以「已中断」的真相留在列表里 —— 用户能看见它、能重试。
    pub async fn take_over_unfinished(&self) -> Vec<EngineTaskRecord> {
        let rows = self.unfinished().await;
        for r in &rows {
            let mut next = r.clone();
            next.status = ST_INTERRUPTED.to_string();
            next.updated_at = next.updated_at.max(now_secs());
            self.upsert(&next).await;
        }
        rows
    }

    async fn query_all(&self, sql: &str) -> Vec<EngineTaskRecord> {
        let stmt = match self.conn.prepare(sql).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[engine-store] prepare failed: {e}");
                return Vec::new();
            }
        };
        let mut rows = match stmt.query(()).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[engine-store] query failed: {e}");
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        loop {
            match rows.next().await {
                Ok(Some(r)) => {
                    if let Some(rec) = record_from_row(&r) {
                        out.push(rec);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[engine-store] row failed: {e}");
                    break;
                }
            }
        }
        out
    }
}

/// 库文件路径：与 TG 库同目录、不同文件（避免互相抢写锁）。
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("engine_tasks.db")
}

/// 当前 Unix 秒（本地小工具，与 `state.rs` 的同名私有函数各自持有，
/// 避免为一个时间戳把两个模块耦在一起）。
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 从一行读出记录；任何字段读不出来都跳过该行（坏行不该让整表不可用）。
fn record_from_row(r: &Row) -> Option<EngineTaskRecord> {
    Some(EngineTaskRecord {
        id: r.get(0).ok()?,
        url: r.get(1).ok()?,
        filename: r.get(2).ok()?,
        // 存量行（本次改造之前写入的）存的是 `\` 形态。读出口统一规范化，
        // 否则「重建二进制之后老任务仍显示 `D://OrigDown//x`」——用户看到的是
        // 「改了没生效」，而真正没改的是库里的旧字符串。
        output: orig_core::paths::to_wire_str(&r.get::<String>(3).ok()?),
        added_at: r.get(4).ok()?,
        updated_at: r.get(5).ok()?,
        max_concurrency: r.get::<i64>(6).ok()?.max(0) as u32,
        category: r.get(7).ok(),
        status: r.get(8).ok()?,
        downloaded: r.get::<i64>(9).ok()?.max(0) as u64,
        total: r.get::<i64>(10).ok()?.max(0) as u64,
        error: r.get(11).ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("orig-daemon-store-{tag}-{}", std::process::id()))
    }

    fn rec(id: &str, status: &str) -> EngineTaskRecord {
        EngineTaskRecord {
            id: id.to_string(),
            url: format!("https://example.invalid/{id}.bin"),
            filename: format!("{id}.bin"),
            output: format!("C:/tmp/{id}.bin"),
            added_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            max_concurrency: 4,
            category: Some("Videos".to_string()),
            status: status.to_string(),
            downloaded: 0,
            total: 1024,
            error: None,
        }
    }

    #[tokio::test]
    async fn upsert_then_read_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let store = TaskStore::open(&dir).await.expect("store must open");
        store.upsert(&rec("t1", ST_DOWNLOADING)).await;

        let all = store.all().await;
        assert_eq!(all.len(), 1, "写入后必须读得回来（修前：内存表，读不到）");
        let got = &all[0];
        assert_eq!(got.id, "t1");
        assert_eq!(got.url, "https://example.invalid/t1.bin");
        assert_eq!(got.filename, "t1.bin");
        assert_eq!(got.category.as_deref(), Some("Videos"));
        assert_eq!(got.total, 1024);
        assert_eq!(got.status, ST_DOWNLOADING);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有牙：若 upsert 每次插入新行（不做 ON CONFLICT），同一任务会变成两行。
    #[tokio::test]
    async fn upsert_is_idempotent_per_id() {
        let dir = tmp_dir("idem");
        let store = TaskStore::open(&dir).await.expect("store must open");
        store.upsert(&rec("t1", ST_DOWNLOADING)).await;
        let mut paused = rec("t1", ST_PAUSED);
        paused.downloaded = 512;
        store.upsert(&paused).await;
        store.upsert(&paused).await;

        let all = store.all().await;
        assert_eq!(all.len(), 1, "同 id 重复写入不得变成多行");
        assert_eq!(all[0].status, ST_PAUSED, "状态必须被后来的写入更新");
        assert_eq!(all[0].downloaded, 512, "终态字节数必须被保留");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本号的核心：进程没了，未完成的行仍在库里且被改写成 `interrupted`。
    ///
    /// 有牙：若没有持久化，`unfinished()` 返回空、行全丢（BUG-319 原样）。
    #[tokio::test]
    async fn unfinished_survives_and_is_taken_over_as_interrupted() {
        let dir = tmp_dir("takeover");
        let store = TaskStore::open(&dir).await.expect("store must open");
        store.upsert(&rec("run1", ST_DOWNLOADING)).await;
        store.upsert(&rec("pause1", ST_PAUSED)).await;
        store.upsert(&rec("done1", ST_COMPLETED)).await;
        store.upsert(&rec("cancel1", ST_CANCELLED)).await;

        // 模拟「另一次进程启动」：库是同一份，内存表是空的。
        let store2 = TaskStore::open(&dir).await.expect("reopen must work");
        let unfinished = store2.unfinished().await;
        assert_eq!(unfinished.len(), 2, "只有未完成的两条属于待办");

        let taken = store2.take_over_unfinished().await;
        assert_eq!(taken.len(), 2, "接管必须覆盖全部未完成行");

        let all = store2.all().await;
        let by_id = |id: &str| all.iter().find(|r| r.id == id).expect("row must survive").clone();
        // 被接管的
        assert_eq!(by_id("run1").status, ST_INTERRUPTED);
        assert_eq!(by_id("pause1").status, ST_INTERRUPTED);
        // 终态保持原样（历史记录不丢、也不被改写）
        assert_eq!(by_id("done1").status, ST_COMPLETED);
        assert_eq!(by_id("cancel1").status, ST_CANCELLED);
        // 接管后再没有未完成的了
        assert!(store2.unfinished().await.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删除是唯一让行消失的路径（用户显式动作）。
    #[tokio::test]
    async fn remove_deletes_the_row() {
        let dir = tmp_dir("remove");
        let store = TaskStore::open(&dir).await.expect("store must open");
        store.upsert(&rec("t1", ST_COMPLETED)).await;
        store.remove("t1").await;
        assert!(store.all().await.is_empty(), "显式删除后行必须消失");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
