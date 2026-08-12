import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { DirectoryPicker } from './DirectoryPicker'
import { useStore } from '../store/useStore'
import { listInterfaces } from '../api/daemon'
import type { NetworkInterface } from '../types'

export function SettingsPanel() {
  const { settings, updateSettings, daemon } = useStore()
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([])
  const [maxConnections, setMaxConnections] = useState(String(settings.maxConnections))
  const [dir, setDir] = useState(settings.downloadDirectory)

  useEffect(() => {
    listInterfaces()
      .then(({ primary, secondaries }) => {
        setInterfaces([primary, ...(secondaries ?? [])].filter(Boolean))
      })
      .catch(() => {})
  }, [])

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">设置</h2>
        <p className="text-xs text-muted">下载与连接配置</p>
      </div>

      {/* 下载 */}
      <section className="space-y-3 rounded-lg border border-border-subtle bg-surface p-4">
        <h3 className="text-sm font-medium text-zinc-200">下载</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">默认下载目录</label>
            <DirectoryPicker value={dir} onChange={setDir} placeholder="~/Downloads" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">最大连接数</label>
            <Input
              type="number"
              min={1}
              max={64}
              value={maxConnections}
              onChange={(e) => setMaxConnections(e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* 网卡 */}
      <section className="space-y-3 rounded-lg border border-border-subtle bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-200">多网卡分流</h3>
          <Badge variant="secondary">{interfaces.length} 个网卡</Badge>
        </div>
        <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
          {interfaces.length === 0 && (
            <p className="text-xs text-muted">daemon 未连接，无法枚举网卡</p>
          )}
          {interfaces.map((iface) => (
            <div
              key={iface.name}
              className="flex items-center justify-between rounded-md bg-surface-2/60 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    iface.enabled ? 'bg-success' : 'bg-muted'
                  }`}
                />
                <span className="font-medium text-zinc-200">{iface.name}</span>
                {iface.is_default && (
                  <Badge variant="default" className="text-[9px]">主</Badge>
                )}
                {!iface.enabled && !iface.is_default && (
                  <Badge variant="outline" className="text-[9px]">未启用</Badge>
                )}
              </div>
              <span className="font-mono text-muted">
                {iface.ip} · w{iface.weight}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          主网卡自动参与；附属网卡需在下载配置中显式开启才参与调度。
        </p>
      </section>

      {/* Daemon 状态 */}
      <section className="space-y-3 rounded-lg border border-border-subtle bg-surface p-4">
        <h3 className="text-sm font-medium text-zinc-200">下载引擎 (surge-daemon)</h3>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              daemon?.alive ? 'bg-success' : 'bg-danger'
            }`}
          />
          <span className="text-zinc-300">
            {daemon?.alive ? '运行中' : '未运行'} · 端口 {daemon?.port ?? 9876}
          </span>
        </div>
        <p className="text-[11px] text-muted">
          {daemon?.managed
            ? '由本应用托管（sidecar）'
            : '外部 daemon（未被本应用管理）'}
        </p>
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="ghost">恢复默认</Button>
        <Button
          onClick={() => {
            updateSettings({
              maxConnections: Number(maxConnections) || 8,
              downloadDirectory: dir,
            })
          }}
        >
          保存
        </Button>
      </div>
    </div>
  )
}
