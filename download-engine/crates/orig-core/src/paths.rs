//! Cross-platform path helpers for the download engine (BUG-071).
//!
//! Two problems are solved here, once, so `orig-daemon` and `orig-tg` cannot
//! drift apart again:
//!
//! - [`default_download_dir`] asks the OS for the *real* download folder
//!   (Windows: `SHGetKnownFolderPath(FOLDERID_Downloads)`, so a user who moved
//!   Downloads to another drive is honoured; macOS/Linux: standard dirs). It
//!   never probes `$HOME` by hand — under MSYS/Git Bash `$HOME` can be a
//!   Unix-style `/c/Users/...` path that native Windows cannot open.
//! - [`expand_tilde`] expands a leading `~` typed by a user into a real
//!   absolute path, so a literal `~` never reaches the filesystem
//!   (`PathBuf::from("~/Downloads")` would create `<CWD>/~/Downloads`).
//! - [`normalize_dir`] folds path spelling a user can produce (`D:\\OrigDown`,
//!   `D:/OrigDown/`, `D://OrigDown`) into one canonical form, so "the same
//!   directory" is literally the same string everywhere (download root, DB
//!   rows, boundary checks) — see BUG-323 re-report 2026-10-19.

use std::path::{Path, PathBuf};

/// The current user's home directory, or `None` when it cannot be determined.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Expand a leading `~` in a user-supplied path string.
///
/// Only two forms are expanded: the bare `~`, and `~` immediately followed by a
/// path separator (`/` or `\`). Everything else — `~user/...`, a `~` in the
/// middle of the path — is left untouched. When the home directory cannot be
/// determined the input is returned unchanged; callers that care about the
/// degradation must log it themselves.
pub fn expand_tilde(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
            if let Some(home) = home_dir() {
                let tail = rest.trim_start_matches(['/', '\\']);
                return if tail.is_empty() { home } else { home.join(tail) };
            }
        }
    }
    PathBuf::from(input)
}

/// [`expand_tilde`] for values that are already a [`PathBuf`] (e.g. a config
/// field or a directory read back from the settings store). Non-UTF-8 paths are
/// returned unchanged.
pub fn expand_tilde_path(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(s) => expand_tilde(s),
        None => path.to_path_buf(),
    }
}

/// **Nominal default download directory** (the OS download folder, `~/Downloads`).
///
/// This is only a *nominal* default: the setting that exists so "unconfigured"
/// has a defined value. It is **never used as a content write root** — see
/// [`content_root`] and [`is_forbidden_content_drive`]. Resolution order:
///   1. [`dirs::download_dir`] — OS known-folder API (honours redirection).
///   2. `<home>/Downloads` — best effort when the known folder is unavailable.
///   3. `.` — last resort when there is no home directory at all.
pub fn default_download_dir() -> PathBuf {
    if let Some(dir) = dirs::download_dir() {
        return dir;
    }
    if let Some(home) = home_dir() {
        let fallback = home.join("Downloads");
        tracing::warn!(
            "system download directory unavailable; falling back to {}",
            fallback.display()
        );
        return fallback;
    }
    tracing::warn!(
        "cannot determine system download directory or home directory; \
         falling back to the D: content root (ruling: all content goes to the D: drive)"
    );
    content_root()
}

/// The OS download folder (`~/Downloads`) — **legacy source identification only**.
///
/// Why this is separate from [`default_download_dir`]: before the 2026-10-19
/// ruling ("never write content to the OS drive"), that *was* the content
/// default, so the engine's library and cache bytes physically live under it on
/// existing installs. Migration has to be able to *name* that folder to move the
/// bytes out of it — while no resolution path may ever write there again.
///
/// **Never use this as a write target.** Resolution order:
///   1. [`dirs::download_dir`] — OS known-folder API.
///   2. `<home>/Downloads` — best effort when the known folder is unavailable.
///   3. `None` — the caller skips the legacy source rather than guessing.
pub fn os_download_dir() -> Option<PathBuf> {
    if let Some(dir) = dirs::download_dir() {
        return Some(dir);
    }
    home_dir().map(|home| home.join("Downloads"))
}

/// The **content root on the D: drive** — the value a forbidden root resolves to.
///
/// Ruling (verbatim, 2026-10-19): 「禁止往C盘写入任何数据,已经爆炸了. 所有内容应该写D盘」
/// and, on how the nominal default relates to it: 「~/Downloads是默认设置,但是不使用,
/// 改用加载配置的D盘设置,因为C盘禁用规则」.
///
/// So the OS download folder keeps existing as the *nominal* default, but every
/// resolution that would land on a forbidden drive is redirected here instead.
/// The live `download-engine.toml` / orig-tg `download_dir` settings already
/// point at this directory; this constant is what an **unconfigured or
/// C:-configured** install resolves to, so such an install lands on the same
/// place rather than on the forbidden drive.
pub const CONTENT_ROOT: &str = r"D:\OrigDown";

/// [`CONTENT_ROOT`] as a [`PathBuf`].
pub fn content_root() -> PathBuf {
    PathBuf::from(CONTENT_ROOT)
}

/// Drives that must **never** hold content bytes (ruling 2026-10-19).
///
/// The OS drive is the one that "exploded"; it holds the OS, page file and the
/// user's own files, so engine-written media/cache must never accumulate there.
/// UNC paths are not drive-lettered and are therefore not forbidden here.
pub fn is_forbidden_content_drive(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let drive: String = s.chars().take(2).collect();
    drive.len() == 2
        && drive.as_bytes()[1] == b':'
        && drive.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && drive.eq_ignore_ascii_case(FORBIDDEN_CONTENT_DRIVE)
}

/// A path is a **valid content root** only if it names a real, non-root,
/// non-forbidden directory (e.g. `D:/OrigDown`). Degenerate values — the bare
/// unix root `/`, a bare drive root like `C:/` or `D:/`, the current dir `.` —
/// must never become the content write root, or every download lands in the
/// filesystem root and the UI shows `/` as the effective path.
///
/// Subsumes [`is_forbidden_content_drive`]: a forbidden (C:) drive is, by
/// definition, not a valid content root.
pub fn is_valid_content_root(path: &Path) -> bool {
    let s = path.to_string_lossy();
    // empty, current dir, or bare unix root are never valid content roots.
    if s.is_empty() || s == "." || s == "/" {
        return false;
    }
    // bare drive root: `C:` (len 2) or `C:/` (len 3, separator after the colon).
    if s.len() <= 3 && s.ends_with(':') {
        return false;
    }
    if s.len() == 3
        && s.as_bytes().get(1) == Some(&b':')
        && (s.ends_with('/') || s.ends_with('\\'))
    {
        return false;
    }
    !is_forbidden_content_drive(path)
}

/// The forbidden content drive letter (the OS drive, `C:` on this deployment).
pub const FORBIDDEN_CONTENT_DRIVE: &str = "C:";

/// Canonical spelling for a **directory** path string.
///
/// Why this exists (BUG-323 re-report, 2026-10-19): the live stack was found
/// with `download_dir = "D://OrigDown"` — a form no user ever typed. Separator
/// spelling that users *can* produce (`D:\\OrigDown` pasted from elsewhere,
/// `D:/OrigDown/` from the in-app browser, `D://OrigDown` after a `\` → `/`
/// rewrite that does not fold duplicates) must converge to **one** literal,
/// because every boundary decision and every DB prefix rewrite is a **string**
/// comparison. Windows tolerates duplicate separators at the API layer, which
/// is exactly what let the bad spelling survive into config and DB.
///
/// Rules (after the caller has already expanded `~`):
/// - `\` is rewritten to `/` (the TOML writer already assumes this form);
/// - runs of separators collapse to one — **except** a leading UNC `//`;
/// - a trailing separator is trimmed, but a drive root (`C:/`) and Unix `/`
///   are preserved;
/// - case is **not** touched (Windows case-insensitivity is handled by the
///   consumers of this helper, e.g. the prefix comparisons in `orig-tg`, not
///   here).
pub fn normalize_dir(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(s.len());
    // UNC `\\server\share` / `//server/share`: keep the leading double slash,
    // it is part of the server identity, not a separator run.
    let body = if s.starts_with("\\\\") || s.starts_with("//") {
        out.push_str("//");
        &s[2..]
    } else {
        s
    };
    let mut prev_slash = false;
    for ch in body.chars() {
        match ch {
            '\\' | '/' => {
                if !prev_slash {
                    out.push('/');
                }
                prev_slash = true;
            }
            _ => {
                out.push(ch);
                prev_slash = false;
            }
        }
    }
    // Trim the trailing separator, but keep a drive root (`C:/`, len 3, `:` at
    // index 1) and a bare Unix root (`/`).
    while out.len() > 1 && out.ends_with('/') {
        let is_drive_root = out.len() == 3 && out.as_bytes().get(1) == Some(&b':');
        if is_drive_root {
            break;
        }
        out.pop();
    }
    out
}

/// [`normalize_dir`] for values that are already a [`PathBuf`].
pub fn normalize_dir_path(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(s) => PathBuf::from(normalize_dir(s)),
        None => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_expands_bare_and_leading_tilde() {
        let Some(home) = home_dir() else {
            return; // no home directory in this environment: nothing to assert
        };
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/Downloads"), home.join("Downloads"));
        assert_eq!(expand_tilde("~\\Downloads"), home.join("Downloads"));
        // a literal tilde must never survive into a filesystem path
        assert!(!expand_tilde("~/Downloads").to_string_lossy().contains('~'));
    }

    #[test]
    fn expand_tilde_leaves_other_forms_untouched() {
        assert_eq!(expand_tilde("~user/Downloads"), PathBuf::from("~user/Downloads"));
        assert_eq!(expand_tilde("/tmp/~/Downloads"), PathBuf::from("/tmp/~/Downloads"));
        assert_eq!(expand_tilde("D:/Downloads"), PathBuf::from("D:/Downloads"));
        assert_eq!(expand_tilde(""), PathBuf::from(""));
    }

    #[test]
    fn expand_tilde_path_matches_string_variant() {
        assert_eq!(expand_tilde_path(Path::new("~/x")), expand_tilde("~/x"));
    }

    #[test]
    fn default_download_dir_is_usable() {
        let dir = default_download_dir();
        assert!(!dir.as_os_str().is_empty(), "default download dir must not be empty");
        assert!(
            !dir.to_string_lossy().contains('~'),
            "default download dir must not contain a literal tilde: {}",
            dir.display()
        );
        // when a home directory exists the result is anchored to an absolute path
        if home_dir().is_some() {
            assert!(dir.is_absolute(), "expected absolute path, got {}", dir.display());
        }
    }

    /// 用户裁定（2026-10-19）：「禁止往C盘写入任何数据,所有内容应该写D盘」。
    ///
    /// 判据是**解析结果**，不是「默认值长什么样」：名义默认 `~/Downloads` 仍在
    /// （用户原话「~/Downloads是默认设置,但是不使用」），但任何解析到禁用盘的
    /// 根都必须被改成 D 盘内容根，否则装机一开箱就把内容写进系统盘
    /// （活栈实测 30.2 GB 就是这么积起来的）。
    #[test]
    #[cfg(windows)]
    fn forbidden_content_drive_is_detected_and_redirected() {
        // ① 系统盘路径必须被认出
        assert!(is_forbidden_content_drive(Path::new(r"C:\OrigDown")));
        assert!(is_forbidden_content_drive(Path::new(r"c:/users/u/downloads")));
        // ② D 盘与 UNC 不得被误判（误判 = 把 D 盘内容也改道）
        assert!(!is_forbidden_content_drive(Path::new(r"D:\OrigDown")));
        assert!(!is_forbidden_content_drive(Path::new(r"d:\videos")));
        assert!(!is_forbidden_content_drive(Path::new(r"\\nas\share")));
        assert!(!is_forbidden_content_drive(Path::new("/home/u/Downloads")));
        // ③ 名义默认在系统盘上 ⇒ 实际内容根必须在 D 盘
        if is_forbidden_content_drive(&default_download_dir()) {
            assert!(!is_forbidden_content_drive(&content_root()));
        }
    }

    // ---- normalize_dir (BUG-323 re-report 2026-10-19) ----

    #[test]
    fn normalize_dir_folds_separator_spelling() {
        // 活栈实测污染形态（BUG-323 复报）：必须收敛到同一个字面
        assert_eq!(normalize_dir("D://OrigDown"), "D:/OrigDown");
        assert_eq!(normalize_dir("D:\\OrigDown"), "D:/OrigDown");
        assert_eq!(normalize_dir("D:/OrigDown"), "D:/OrigDown");
        assert_eq!(normalize_dir("D:\\OrigDown\\"), "D:/OrigDown");
        assert_eq!(normalize_dir("  D:/OrigDown  "), "D:/OrigDown");
        assert_eq!(normalize_dir("D:\\Videos\\a\\b"), "D:/Videos/a/b");
        assert_eq!(normalize_dir(""), "");
    }

    #[test]
    fn normalize_dir_keeps_drive_and_unix_roots() {
        assert_eq!(normalize_dir("C:/"), "C:/");
        assert_eq!(normalize_dir("C:\\"), "C:/");
        assert_eq!(normalize_dir("C://"), "C:/");
        assert_eq!(normalize_dir("/"), "/");
        // UNC：前导双斜杠是服务器身份的一部分，不是分隔符连排
        assert_eq!(normalize_dir("\\\\server\\share\\x"), "//server/share/x");
        assert_eq!(normalize_dir("//server/share/"), "//server/share");
    }

    #[test]
    fn normalize_dir_preserves_case() {
        // 大小写不敏感由消费方（前缀比较）负责，此处不擅自改
        assert_eq!(normalize_dir("d:/origdown"), "d:/origdown");
    }

    #[test]
    fn normalize_dir_path_matches_string_variant() {
        assert_eq!(
            normalize_dir_path(Path::new("D://OrigDown")),
            PathBuf::from("D:/OrigDown")
        );
    }

    #[test]
    fn normalize_dir_is_idempotent() {
        for raw in ["D://OrigDown", "D:\\OrigDown\\sub\\", "//srv/share/x"] {
            let once = normalize_dir(raw);
            assert_eq!(normalize_dir(&once), once, "not idempotent for {raw}");
        }
    }

    #[test]
    fn is_valid_content_root_rejects_degenerate_paths() {
        // 合法内容根
        assert!(is_valid_content_root(Path::new("D:/OrigDown")));
        assert!(is_valid_content_root(Path::new("D:/a/b")));
        // 退化值一律拒绝
        assert!(!is_valid_content_root(Path::new("/")), "裸 unix 根不可作内容根");
        assert!(!is_valid_content_root(Path::new(".")), "当前目录不可作内容根");
        assert!(!is_valid_content_root(Path::new("")), "空路径不可作内容根");
        assert!(!is_valid_content_root(Path::new("D:/")), "盘符根不可作内容根");
        assert!(!is_valid_content_root(Path::new("C:/")), "C: 盘符根不可作内容根");
        assert!(!is_valid_content_root(Path::new("C:/Users/me/Downloads")), "C: 禁用盘不可作内容根");
        // UNC 共享视为合法
        assert!(is_valid_content_root(Path::new("//server/share")));
    }
}
