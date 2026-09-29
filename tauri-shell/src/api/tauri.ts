import { invoke } from '@tauri-apps/api/core'
import type { DaemonStatus } from '../types'

/** 查询 daemon 是否存活（Rust 命令） */
export function daemonStatus(): Promise<DaemonStatus> {
  return invoke('daemon_status')
}

/** 确保 daemon 运行（Rust 命令，幂等） */
export function ensureDaemon(): Promise<{ started: boolean; port: number; reason?: string }> {
  return invoke('ensure_daemon')
}

/** 停止由本应用托管的 daemon */
export function stopDaemon(): Promise<void> {
  return invoke('stop_daemon')
}

/**
 * 保存 Telegram 配置（api_id/api_hash/proxy）。
 *
 * 壳只负责写 `tg/config.json`，随后**请 daemon 重启**它托管的 orig-tg（BUG-178）：
 * 进程生命周期归 daemon 独占，壳不再 spawn / kill（那会让 TG 进程有两个主人）。
 * 返回 `restarted=false` 表示 daemon 不在跑 —— 凭证已存，下次启动生效。
 */
export function tgSaveConfig(
  apiId: string,
  apiHash: string,
  proxy: string,
): Promise<{ saved: boolean; restarted: boolean; daemon?: string; reason?: string }> {
  return invoke('tg_save_config', { apiId, apiHash, proxy })
}
