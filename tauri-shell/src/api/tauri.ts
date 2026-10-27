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

/**
 * 确保 daemon 就绪，**有界重试**（BUG-448）。
 *
 * 为什么需要重试：`ensure_daemon` 在壳侧等 daemon 就绪（上限 35s，超时会杀掉子进程）。
 * 单次调用仍可能失败——冷启动时杀软扫描大二进制、端口被占后需要换端口、上次崩溃留下的
 * 状态——这些都**会自愈**，只要再试一次。原先前端只调用一次，失败后界面永久停在
 * 「离线」，用户唯一出路是关掉重开。
 *
 * 为什么是**有界**：3 次封顶、退避 1s/3s。无限重试等于把系统的失职变成永不停歇的
 * 噪音，而且掩盖了「真的起不来」这个必须让用户知道的事实。
 *
 * 每次失败后先用 `daemonStatus()` 廉价探一次：daemon 可能已经自己起来了（上次调用
 * 只是「等得不够久」），那就不必再拉起一个新的——多拉一个只会抢端口。
 */
export async function ensureDaemonReady(
  attempts = 3,
): Promise<{ started: boolean; port: number; reason?: string }> {
  const backoffMs = [1000, 3000]
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await ensureDaemon()
    } catch (e) {
      lastErr = e
      // 先看是不是「其实已经起来了」——只差一次探测
      try {
        const st = await daemonStatus()
        if (st?.alive) return { started: false, port: st.port, reason: 'already-running' }
      } catch {
        // 探测本身失败（非 Tauri 环境等）：继续走重试
      }
      const wait = backoffMs[Math.min(i, backoffMs.length - 1)]
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr ?? new Error('ensure daemon failed')
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
