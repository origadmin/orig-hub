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

/** 查询 orig-tg（Telegram 服务）是否存活（Rust 命令） */
export function tgStatus(): Promise<{ alive: boolean; port: number; managed: boolean }> {
  return invoke('tg_status')
}

/** 确保 orig-tg 运行（Rust 命令，幂等）；未配置凭证时抛错 "not-configured" */
export function ensureTg(): Promise<{ started: boolean; port: number; reason?: string }> {
  return invoke('ensure_tg')
}

/** 保存 Telegram 配置（api_id/api_hash/proxy）并（重）启动 orig-tg */
export function tgSaveConfig(apiId: string, apiHash: string, proxy: string): Promise<{ started: boolean }> {
  return invoke('tg_save_config', { apiId, apiHash, proxy })
}
