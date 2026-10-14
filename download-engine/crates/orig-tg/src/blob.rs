//! 内容寻址 blob 存储（D24-A / BUG-309）。
//!
//! ## 布局
//!
//! ```text
//! <download_dir>/.blobs/ab/cd/<64hex>     -- 正式 blob，无扩展名
//! <download_dir>/.blobs/_tmp/<uuid>.part  -- 落盘中，唯一临时区
//! ```
//!
//! - **两段分片**（`hash[0..2]` / `hash[2..4]`）：256×256 = 65536 个末级目录，
//!   百万文件平均 15 个/目录，是「目录扇出」与「目录总数」的均衡点（git / OCI 同款）。
//! - **无扩展名**：hash 已是完整内容标识；扩展名属显示层（`media_item.kind`），
//!   进路径只会带来「同一 blob 两种扩展名」的分裂。投递端 MIME 按 kind 判定。
//! - **`_tmp` 与 `blobs/` 同卷**（同在一个 `.blobs/` 下）⇒ `rename` 原子且近零成本。
//!
//! ## 与「清缓存」的关系（用户 2026-10-14 拍板：blob 落在下载目录内）
//!
//! blob 落在**下载目录**内，故进得了清理工作集；清理按**引用计数**回收
//! （`Store::release_blob` 归零才 unlink），共享 blob 的其余条目不会变死链。
//!
//! ## 为什么不用 `access_hash` 作内容标识
//!
//! 它是 `FileLocation` 的**权限令牌**（可轮换），且只有 TG 来源才有；同一内容在不同
//! 频道 / 不同消息里取值可能不同 ⇒ 起不到去重作用。内容 hash 与来源无关，本地导入
//! 条目同样可算。

use std::path::{Path, PathBuf};

/// blob 区目录名（相对下载目录）。
pub const BLOB_DIR: &str = ".blobs";
/// 落盘中临时区目录名（相对 blob 区）。
pub const TMP_DIR: &str = "_tmp";

/// blob 区根：`<download_dir>/.blobs`。
pub fn blob_root(download_dir: &Path) -> PathBuf {
    download_dir.join(BLOB_DIR)
}

/// 临时区：`<download_dir>/.blobs/_tmp`（落盘中的 `.part` 都放这里）。
pub fn tmp_dir(download_dir: &Path) -> PathBuf {
    blob_root(download_dir).join(TMP_DIR)
}

/// 某个 hash 的 blob 绝对路径：`<download_dir>/.blobs/ab/cd/<hash>`。
///
/// `hash` 短于 4 字符时退化为单层（防御性；调用方只会传 64 hex）。
pub fn blob_path(download_dir: &Path, hash: &str) -> PathBuf {
    let root = blob_root(download_dir);
    if hash.len() >= 4 {
        root.join(&hash[0..2]).join(&hash[2..4]).join(hash)
    } else {
        root.join(hash)
    }
}

/// 新临时文件路径：`<download_dir>/.blobs/_tmp/<uuid>.part`。
pub fn tmp_path(download_dir: &Path) -> PathBuf {
    tmp_dir(download_dir).join(format!("{}.part", uuid::Uuid::new_v4()))
}

/// 该路径是否落在 blob 临时区（`_tmp` 子树）—— 扫描/孤儿判定据此跳过落盘中文件。
///
/// 与「扩展名 `.part`」判定互补（历史残留的 `.part` 可能还在旧位置）。
pub fn is_tmp_path(p: &Path) -> bool {
    p.parent()
        .and_then(|d| d.file_name())
        .map(|n| n == TMP_DIR)
        .unwrap_or(false)
}

/// 该路径是否落在 blob 区（`.blobs` 子树）内 —— 用于「是否是受管 blob 字节」的判定。
pub fn is_blob_path(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str() == BLOB_DIR)
}

/// 小写 hex 编码（仓库无 `hex` crate，统一手写）。
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 顺序读一个文件算 SHA-256（64 KiB 缓冲）。
///
/// 用于**存量懒纳入**（`content_hash IS NULL` 的行在触及时补 hash）与测试；
/// 落盘主路径走**流式**（`grammers::PartFile`），不经过这里、不二次读盘。
pub fn hash_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_path_uses_two_level_sharding() {
        let dl = Path::new("/dl");
        let h = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let p = blob_path(dl, h);
        assert!(
            p.ends_with(Path::new("ab").join("cd").join(h)),
            "两段分片：hash[0..2]/hash[2..4]/hash，实测 {p:?}"
        );
        assert!(is_blob_path(&p));
        // 反向证伪：单段分片（只取前两位）会落在 `.blobs/ab/<hash>`，与两段式不等。
        assert!(!p.ends_with(Path::new("ab").join(h)), "必须两段，不是单段");
    }

    #[test]
    fn tmp_paths_live_under_the_tmp_subtree() {
        let dl = Path::new("/dl");
        let t = tmp_path(dl);
        assert!(is_tmp_path(&t), "临时文件必须在 _tmp 子树：{t:?}");
        assert!(is_blob_path(&t));
        assert_eq!(t.parent().unwrap(), tmp_dir(dl));
        // 正式 blob 不在 _tmp 子树。
        let h = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(!is_tmp_path(&blob_path(dl, h)));
    }

    #[test]
    fn hash_file_is_content_addressed() {
        let dir = std::env::temp_dir().join(format!("orig_blob_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        std::fs::write(&a, b"same-bytes").unwrap();
        std::fs::write(&b, b"same-bytes").unwrap();
        let c = dir.join("c.bin");
        std::fs::write(&c, b"different").unwrap();
        assert_eq!(hash_file(&a).unwrap(), hash_file(&b).unwrap(), "同内容同 hash");
        assert_ne!(hash_file(&a).unwrap(), hash_file(&c).unwrap(), "异内容异 hash");
        // 锁死形态：SHA-256 = 64 位小写 hex（不是「某种 hash」，也不是 base64/大写）。
        let ha = hash_file(&a).unwrap();
        assert_eq!(ha.len(), 64, "SHA-256 hex 必须 64 字符");
        assert!(
            ha.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()),
            "必须小写 hex：{ha}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
