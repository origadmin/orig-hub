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
