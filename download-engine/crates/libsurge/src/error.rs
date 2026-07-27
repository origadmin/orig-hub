use thiserror::Error;

/// 统一错误类型。
#[derive(Debug, Error)]
pub enum SurgeError {
    #[error("unsupported scheme or protocol: {0}")]
    Unsupported(String),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("download failed: {0}")]
    Download(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("cancelled")]
    Cancelled,

    #[error("no available source for block")]
    NoSource,

    #[error("other: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, SurgeError>;
