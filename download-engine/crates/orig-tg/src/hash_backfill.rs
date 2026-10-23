//! 存量内容 hash 回填（BUG-420）。
//!
//! ## 为什么需要它
//!
//! `content_hash` 的唯一生产点是**流式落盘到内容寻址区**（`grammers::PartFile::
//! finish_into_blob` → `routes.rs` → `backfill_item_bytes_with_blob`）。D24-A
//! （BUG-309）2026-10-12 才落地，此前下载的条目没有 hash；走平铺降级分支的也没有。
//! 实测真实库 596 条里只有 47 条有 hash（video 19/377）⇒ BUG-407/408 的
//! 「同 hash ⇒ 同一集」判据对绝大多数条目**恒不成立**。
//!
//! `blob::hash_file` 的文档早就写着「存量懒纳入（`content_hash IS NULL` 的行在触及时
//! 补 hash）」，但全仓**零生产调用点** —— 本模块把它接上。
//!
//! ## 纪律
//!
//! - **只补 hash，不搬字节**：平铺条目的文件留在原处，`file_path` 一字不改。
//!   搬进 `.blobs` 是 D24-A 的「纳入」动作，会改 120 条路径、内容重复时留下两份字节
//!   —— 破坏性迁移，须单独拍板，不在本模块职责内。
//! - **不碰引用计数**：写 hash 走 `Store::set_item_content_hash`（不 acquire）。
//!   `media_blob` 只登记「字节真的在 `.blobs` 下」的条目（`recount_blobs` 有闸）。
//! - **幂等**：扫描集是 `content_hash IS NULL`，补过的自然出集；重复调用只做零事。
//! - **文件不存在就跳过**（计数，不报错）：路径悬空是另一类缺陷（旧平铺布局 / 临时夹具），
//!   hash 无从算起 —— 不能把它伪装成「算过但为空」。

use std::sync::Arc;

use crate::blob;
use crate::cache::resolve_item_path;
use crate::media::Store;
use crate::state::AppState;

/// 一次回填的结果（同时是 `POST /api/media/hashes/backfill` 的响应体）。
///
/// `rename_all = "camelCase"`：本服务的 HTTP JSON 一律 camelCase
/// （`mergedSameEpisode` / `skippedCount` 同款），字段名直接进前端类型。
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReport {
    /// 进入扫描集的条目数（`content_hash` 为空且有 `file_path`）。
    pub scanned: i64,
    /// 补上 hash 的条目数。
    pub hashed: i64,
    /// 文件不存在而跳过的条目数（路径悬空）。
    pub missing_file: i64,
    /// 读盘 / 写库失败的条目数（已记日志，不影响其余条目）。
    pub failed: i64,
    /// 耗时（毫秒）—— 真实库首跑要读 20 GB（251 个文件），SSD 上约 1–3 分钟；
    /// 全部是顺序读、单并发，不与播放/下载抢同一文件。
    pub elapsed_ms: u64,
}

impl BackfillReport {
    pub fn is_noop(&self) -> bool {
        self.scanned == 0
    }

    pub fn summary(&self) -> String {
        format!(
            "scanned {} / hashed {} / missing_file {} / failed {} ({} ms)",
            self.scanned, self.hashed, self.missing_file, self.failed, self.elapsed_ms
        )
    }
}

/// 带 `AppState` 的入口（启动钩子与 HTTP 端点用）。
///
/// 真正的逻辑在 [`backfill_store`] —— 那一层只依赖 `Store`，可脱离 AppState 单测
/// （`AppState` 要 MTProto 客户端，测试里造不出来）。
pub async fn backfill_content_hashes(st: &Arc<AppState>, limit: usize) -> BackfillReport {
    let rep = backfill_store(&st.store, limit, &|line| st.push_log(line)).await;
    if !rep.is_noop() {
        st.push_log(format!("BUG-420 hash backfill done: {}", rep.summary()));
    }
    rep
}

/// 给存量条目补内容 hash（核心实现）。
///
/// `limit` = 0 表示不限（启动时全量）。相对 `file_path` 按 `Store::library_root()`
/// 解析 —— 与所有读字节的路径走**同一个**解析器（`cache::resolve_item_path`）。
pub async fn backfill_store(
    store: &Store,
    limit: usize,
    log: &(dyn Fn(String) + Sync),
) -> BackfillReport {
    let lib_root = store.library_root().await;
    backfill_store_with_root(store, &lib_root, limit, log).await
}

/// 同上，但**库根由调用方给**（`backfill_store` 只是「库根取 store 的」那层壳）。
///
/// 单独拆出来的唯一理由：相对路径解析是这条链路最容易静默失效的一环 ——
/// 库根算错 ⇒ 251 个真实文件全被判「不存在」，回填一条也补不上，而报表只会显示
/// `missing_file: 251`（看着像「文件本来就没有」）。生产库根写死在用户盘上，
/// 单测不能往那儿写，所以必须能把根注进来才测得动。
pub async fn backfill_store_with_root(
    store: &Store,
    lib_root: &std::path::Path,
    limit: usize,
    log: &(dyn Fn(String) + Sync),
) -> BackfillReport {
    let started = std::time::Instant::now();
    let mut rep = BackfillReport::default();
    let rows = match store.list_items_missing_hash(limit).await {
        Ok(r) => r,
        Err(e) => {
            log(format!("BUG-420 hash backfill: list failed: {e}"));
            rep.elapsed_ms = started.elapsed().as_millis() as u64;
            return rep;
        }
    };
    rep.scanned = rows.len() as i64;
    if rows.is_empty() {
        rep.elapsed_ms = started.elapsed().as_millis() as u64;
        return rep;
    }
    for (id, file_path) in rows {
        let abs = resolve_item_path(lib_root, &file_path);
        if !abs.is_file() {
            // 路径悬空：hash 无从算起。计数而不报错 —— 它不是本次修复的对象。
            rep.missing_file += 1;
            continue;
        }
        // 读盘算 SHA-256 是**阻塞** IO（单文件可达数百 MB），必须让出 async 线程。
        let p = abs.clone();
        let hash = match tokio::task::spawn_blocking(move || blob::hash_file(&p)).await {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                rep.failed += 1;
                log(format!(
                    "BUG-420 hash backfill: read {} failed: {e}",
                    abs.display()
                ));
                continue;
            }
            Err(e) => {
                rep.failed += 1;
                log(format!(
                    "BUG-420 hash backfill: join error for {}: {e}",
                    abs.display()
                ));
                continue;
            }
        };
        match store.set_item_content_hash(id, &hash).await {
            Ok(true) => rep.hashed += 1,
            Ok(false) => {
                rep.failed += 1;
                log(format!("BUG-420 hash backfill: item {id} vanished before write"));
            }
            Err(e) => {
                rep.failed += 1;
                log(format!("BUG-420 hash backfill: write item {id} failed: {e}"));
            }
        }
    }
    rep.elapsed_ms = started.elapsed().as_millis() as u64;
    rep
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsql::params;

    fn tmp_db(tag: &str) -> std::path::PathBuf {
        // 墙钟类临时库留 `%TEMP%`（D: fsync 慢 10 倍，见项目约定）。
        let p = std::env::temp_dir().join(format!(
            "orig_hash_bf_{tag}_{}_{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        p
    }

    async fn seed_item(s: &Store, name: &str, path: Option<&str>) -> i64 {
        s.upsert_media_item("tg", &format!("-100:{name}"), name, "video", path, None, None, None)
            .await
            .unwrap();
        s.item_id_by_ref("tg", &format!("-100:{name}"))
            .await
            .unwrap()
            .expect("seeded item")
    }

    /// 回填**只**给真实存在的文件算 hash：缺文件的跳过并计数，已算过的不再进扫描集。
    /// 反向证伪：若把「文件不存在」也写 hash，`hashed` 会变成 2（FAIL）。
    #[tokio::test]
    async fn backfill_hashes_only_real_files_and_is_idempotent_bug420() {
        let s = Store::open(tmp_db("real")).await.unwrap();
        let dir = std::env::temp_dir().join(format!("orig_hash_bf_files_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        std::fs::write(&a, b"hello-hash").unwrap();
        std::fs::write(&b, b"hello-hash").unwrap(); // 同内容 ⇒ 同 hash
        let gone = dir.join("gone.bin"); // 从不创建

        let ia = seed_item(&s, "a", Some(a.to_str().unwrap())).await;
        let ib = seed_item(&s, "b", Some(b.to_str().unwrap())).await;
        let ic = seed_item(&s, "c", Some(gone.to_str().unwrap())).await;

        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let rep = backfill_store(&s, 0, &|m| logs.lock().unwrap().push(m)).await;
        assert_eq!(rep.scanned, 3, "三条都无 hash ⇒ 全进扫描集");
        assert_eq!(rep.hashed, 2, "两个真文件补上；缺失的**不**补");
        assert_eq!(rep.missing_file, 1, "缺文件单独计数，不是失败");
        assert_eq!(rep.failed, 0);

        let want = blob::hash_file(&a).unwrap();
        let got: Option<String> = s
            .row_opt("SELECT content_hash FROM media_item WHERE id = ?1", params![ia])
            .await
            .unwrap()
            .and_then(|r| r.get::<Option<String>>(0).ok())
            .flatten();
        assert_eq!(got.as_deref(), Some(want.as_str()), "hash 必须等于文件内容的 SHA-256");
        let got_c: Option<String> = s
            .row_opt("SELECT content_hash FROM media_item WHERE id = ?1", params![ic])
            .await
            .unwrap()
            .and_then(|r| r.get::<Option<String>>(0).ok())
            .flatten();
        assert_eq!(got_c, None, "缺文件的条目必须保持 NULL（不能伪装成算过）");
        let got_b: Option<String> = s
            .row_opt("SELECT content_hash FROM media_item WHERE id = ?1", params![ib])
            .await
            .unwrap()
            .and_then(|r| r.get::<Option<String>>(0).ok())
            .flatten();
        assert_eq!(got_b, got, "同内容 ⇒ 同 hash（归并判据的前提）");

        // 幂等：再跑一次，扫描集只剩「缺文件」那一条（它仍无 hash），补上 0 条。
        let rep2 = backfill_store(&s, 0, &|_| {}).await;
        assert_eq!(rep2.scanned, 1, "已补的不再进扫描集");
        assert_eq!(rep2.hashed, 0, "重复回填必须零写");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 相对路径必须按**库根**解析 —— 真实库里 251 个待补文件的 `file_path` 全是
    /// 库根相对形式（`<频道目录>/<msg>-<title>.mp4`）。库根算错 ⇒ 全部判「文件不存在」，
    /// 报表显示 `missing_file: 251`，看着像「文件本来就没有」，实际是解析错。
    /// 反向证伪：把根换成不存在的目录，`hashed` 必须从 1 掉到 0。
    #[tokio::test]
    async fn backfill_resolves_relative_paths_against_library_root_bug420() {
        let root = std::env::temp_dir().join(format!("orig_hash_bf_root_{}", std::process::id()));
        std::fs::create_dir_all(root.join("chat-1")).unwrap();
        let f = root.join("chat-1").join("1-media.mp4");
        std::fs::write(&f, b"relative-payload").unwrap();
        let want = blob::hash_file(&f).unwrap();

        let s = Store::open(tmp_db("relroot")).await.unwrap();
        let id = seed_item(&s, "rel", Some("chat-1/1-media.mp4")).await;
        let rep = backfill_store_with_root(&s, &root, 0, &|_| {}).await;
        assert_eq!(rep.hashed, 1, "库根相对路径必须解析得到真文件");
        let got: Option<String> = s
            .row_opt("SELECT content_hash FROM media_item WHERE id = ?1", params![id])
            .await
            .unwrap()
            .and_then(|r| r.get::<Option<String>>(0).ok())
            .flatten();
        assert_eq!(got.as_deref(), Some(want.as_str()));

        let wrong = root.join("not-the-library-root");
        let s2 = Store::open(tmp_db("relroot2")).await.unwrap();
        seed_item(&s2, "rel", Some("chat-1/1-media.mp4")).await;
        let rep2 = backfill_store_with_root(&s2, &wrong, 0, &|_| {}).await;
        assert_eq!(rep2.hashed, 0, "根错 ⇒ 一条也补不上");
        assert_eq!(rep2.missing_file, 1, "根错 ⇒ 全部记「文件不存在」");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 平铺条目补 hash 后 **不得**凭空产生 blob 行 —— 字节不在 `.blobs` 下，
    /// refcount 一旦记上，归零回收就会去 unlink 一个从不存在的路径。
    /// 反向证伪：去掉 `recount_blobs` 的 `.blobs` 闸，`blob_rows` 会变成 1（FAIL）。
    #[tokio::test]
    async fn hash_only_rows_never_create_blob_rows_bug420() {
        let s = Store::open(tmp_db("blobrow")).await.unwrap();
        let i = seed_item(&s, "flat", Some("/flat/lib/chat/a.mp4")).await;
        s.set_item_content_hash(i, &"ab".repeat(32)).await.unwrap();
        let n = s.recount_blobs().await.unwrap();
        assert_eq!(n, 0, "平铺 hash 不产生 media_blob 行");
        // 受管 blob 仍照常计入（闸不能把正常路径一起挡掉）。
        let j = seed_item(&s, "blob", None).await;
        s.backfill_item_bytes_with_blob(j, "/dl/.blobs/ab/cd/x", None, &"cd".repeat(32), 1)
            .await
            .unwrap();
        let n2 = s.recount_blobs().await.unwrap();
        assert_eq!(n2, 1, "受管 blob 计 1 行；平铺 hash 仍不计");
    }

    /// 平铺 hash 条目清字节时必须允许回收（`clear_item_bytes` 返回 `None`），
    /// 否则 `purge_item` 会把它读成「还有其他引用」⇒ 文件永不删除（静默泄漏）。
    #[tokio::test]
    async fn clear_bytes_on_hash_only_row_reports_reclaimable_bug420() {
        let s = Store::open(tmp_db("clear")).await.unwrap();
        let i = seed_item(&s, "flat2", Some("/flat/lib/chat/b.mp4")).await;
        s.set_item_content_hash(i, &"ef".repeat(32)).await.unwrap();
        let orphan = s.clear_item_bytes(i).await.unwrap();
        assert_eq!(orphan, None, "非受管 blob ⇒ 按老语义可回收（不是 Some(false)）");
        let (h, p): (Option<String>, Option<String>) = s
            .row_opt("SELECT content_hash, file_path FROM media_item WHERE id = ?1", params![i])
            .await
            .unwrap()
            .map(|r| (r.get::<Option<String>>(0).ok().flatten(), r.get::<Option<String>>(1).ok().flatten()))
            .unwrap();
        assert_eq!(h, None, "清字节 ⇒ hash 一并置空");
        assert_eq!(p, None, "清字节 ⇒ 路径一并置空");
    }
}
