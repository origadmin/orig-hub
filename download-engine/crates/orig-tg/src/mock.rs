//! **测试专用** mock 客户端：合成频道/消息/缩略图/下载，替代原先的「骨架占位 Dummy」。
//!
//! 它诞生于骨架期（用于在没有真实 MTProto 实现时自测 axum 契约），但随后被放进了
//! **生产决策路径** —— `build_client` 在「凭证缺失」和「连接失败」两个分支都回退到它，
//! 于是「连不上 TG」被伪装成「服务正常」，成为 BUG-023 的根因。
//!
//! 现在它被彻底逐出生产：
//!
//! 1. `#[cfg(feature = "mock")]` —— 默认构建**不编译**本模块，生产二进制不含合成数据；
//! 2. 必须 `ORIG_TG_MOCK=1` 显式选中，且必须显式 `ORIG_TG_DB`（隔离库，见 `main`）；
//! 3. 失败路径永不回退到它 —— 不可用一律走 [`crate::unavailable::UnavailableClient`]。
//!
//! 这里的实现刻意保持"合成但可观察"：下载按 ~2.4s/条分块写入，让「缓存中 n/N」与
//! 刷新恢复能被真实观察到。

use std::sync::Mutex;

use crate::login::{
    Channel, Client, ClientError, DownloadOutcome, Folder, LoginPhase, MediaItem, MediaRange,
    MediaStream, SessionView, Thumbnail,
};

/// 固定验证码：输入 `00000` 即授权（仅测试用，非真实登录）。
const MOCK_CODE: &str = "00000";

/// 合成频道 id（仅测试构建下存在）。
const MOCK_CHAT_ID: i64 = -1009876543210;

/// 1×1 透明 GIF（35 字节，标准最小合法 GIF）：让 `<img>` 能真正解码。
/// 若返回 None，路由会回 JSON 404，浏览器对 `<img>` 的此类响应触发 ORB 拦截并刷
/// `ERR_BLOCKED_BY_ORB`，把真正的错误信号淹没在噪音里。
const TINY_GIF: [u8; 35] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
    0x01, 0x00, 0x3B,
];

/// 合成客户端：内存持有登录状态，媒体能力全部返回固定夹具数据。
pub struct MockClient {
    state: Mutex<LoginPhase>,
}

impl Default for MockClient {
    fn default() -> Self {
        Self {
            state: Mutex::new(LoginPhase::Anonymous),
        }
    }
}

#[async_trait::async_trait]
impl Client for MockClient {
    async fn start(&self, _phone: &str) -> Result<LoginPhase, ClientError> {
        *self.state.lock().unwrap() = LoginPhase::CodeRequired;
        Ok(LoginPhase::CodeRequired)
    }

    async fn submit_code(&self, _phone: &str, code: &str) -> Result<LoginPhase, ClientError> {
        if code != MOCK_CODE {
            return Err(ClientError::InvalidCode);
        }
        *self.state.lock().unwrap() = LoginPhase::Authorized;
        Ok(LoginPhase::Authorized)
    }

    async fn submit_password(&self, _phone: &str, _password: &str) -> Result<LoginPhase, ClientError> {
        Err(ClientError::Other("no 2FA in mock client".into()))
    }

    async fn view(&self) -> SessionView {
        SessionView {
            phase: self.state.lock().unwrap().clone(),
            phone: None,
            user_id: None,
        }
    }

    async fn dialogs(&self) -> Result<Vec<Channel>, ClientError> {
        Ok(vec![Channel {
            id: MOCK_CHAT_ID,
            title: "Mock Channel".to_string(),
            username: Some("mock".to_string()),
            folder: None,
        }])
    }

    async fn folders(&self) -> Result<Vec<Folder>, ClientError> {
        Ok(Vec::new())
    }

    async fn messages(
        &self,
        _chat_id: i64,
        _limit: u32,
        _before_id: Option<i64>,
    ) -> Result<Vec<MediaItem>, ClientError> {
        // 合成内容：一个 3 项相册（同 group_id）+ 一条单发视频，覆盖两种缓存入口。
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let mk = |id: i64, group: Option<i64>, caption: &str| MediaItem {
            id,
            caption: Some(caption.to_string()),
            mime_type: Some("video/mp4".to_string()),
            size: Some(4 * 1024 * 1024),
            media_type: Some("video".to_string()),
            file_name: None,
            date: Some(now - (100 - id)),
            duration: Some(12),
            group_id: group,
            has_media: true,
        };
        Ok(vec![
            mk(1, Some(9001), "Mock album · 1"),
            mk(2, Some(9001), "Mock album · 2"),
            mk(3, Some(9001), "Mock album · 3"),
            mk(4, None, "Mock single video"),
        ])
    }

    async fn thumb(
        &self,
        _chat_id: i64,
        _message_id: i64,
    ) -> Result<Option<Thumbnail>, ClientError> {
        Ok(Some(Thumbnail {
            content_type: "image/gif".to_string(),
            bytes: TINY_GIF.to_vec(),
        }))
    }

    async fn media(
        &self,
        _chat_id: i64,
        _message_id: i64,
        _range: Option<MediaRange>,
    ) -> Result<MediaStream, ClientError> {
        // 合成环境不提供在线播放流（浏览器会落到「无媒体」提示，而非假播放）。
        Err(ClientError::MediaNotFound)
    }

    async fn download(
        &self,
        chat_id: i64,
        message_id: i64,
        dir: &str,
    ) -> Result<DownloadOutcome, ClientError> {
        let dir = std::path::PathBuf::from(dir);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ClientError::Other(format!("create dir: {e}")))?;
        let path = dir.join(format!("mock-{chat_id}-{message_id}.bin"));
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|e| ClientError::Other(format!("create file: {e}")))?;
        use tokio::io::AsyncWriteExt;
        let mut bytes: u64 = 0;
        let chunk = vec![0u8; 1024 * 1024];
        // 8 × 300ms ≈ 2.4s/条：给「刷新后仍在缓存中」留出可观察窗口。
        // 过快会让任务在刷新完成前就结束，验收只能看到终态、无法复现原缺陷场景。
        for _ in 0..8 {
            file.write_all(&chunk)
                .await
                .map_err(|e| ClientError::Other(format!("write file: {e}")))?;
            bytes += chunk.len() as u64;
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        file.flush()
            .await
            .map_err(|e| ClientError::Other(format!("flush file: {e}")))?;
        Ok(DownloadOutcome {
            message_id,
            path: path.to_string_lossy().into_owned(),
            bytes,
        })
    }

    async fn message_meta(
        &self,
        _chat_id: i64,
        message_id: i64,
    ) -> Result<Option<MediaItem>, ClientError> {
        Ok(self
            .messages(0, 10, None)
            .await?
            .into_iter()
            .find(|m| m.id == message_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_login_flow_transitions() {
        let c = MockClient::default();
        assert_eq!(c.view().await.phase, LoginPhase::Anonymous);

        assert_eq!(c.start("+10000000000").await.unwrap(), LoginPhase::CodeRequired);
        assert!(c.submit_code("+10000000000", "12345").await.is_err());
        assert_eq!(
            c.submit_code("+10000000000", MOCK_CODE).await.unwrap(),
            LoginPhase::Authorized
        );
    }

    /// 夹具必须自带一个相册分组，否则「整组缓存」这条入口无法被验收覆盖。
    #[tokio::test]
    async fn fixture_has_album_group() {
        let msgs = MockClient::default().messages(0, 10, None).await.unwrap();
        assert_eq!(msgs.len(), 4);
        let grouped = msgs.iter().filter(|m| m.group_id == Some(9001)).count();
        assert_eq!(grouped, 3, "fixture must contain a 3-item album");
    }
}
