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

/// Platform default download directory.
///
/// Resolution order, each step logged when it degrades:
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
        "cannot determine system download directory or home directory; falling back to current directory"
    );
    PathBuf::from(".")
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
}
