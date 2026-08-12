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
  // 局部编辑态：全局选中 + 权重（保存时写入 settings.enabledInterfaces）
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [weights, setWeights] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    listInterfaces()
      .then(({ primary, secondaries }) => {
        const all = [primary, ...(secondaries ?? [])].filter(Boolean)
        setInterfaces(all)
        const en: Record<string, boolean> = {}
        const w: Record<string, string> = {}
        for (const nic of all) {
          en[nic.name] = settings.enabledInterfaces[nic.name] != null
          w[nic.name] = String(settings.enabledInterfaces[nic.name] ?? 1)
        }
        setEnabled(en)
        setWeights(w)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <Badge variant="secondary">
            {interfaces.filter((i) => i.connected).length} 个已连接
          </Badge>
        </div>
        <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
          {interfaces.length === 0 && (
            <p className="text-xs text-muted">daemon 未连接，无法枚举网卡</p>
          )}
          {interfaces.map((iface) => {
            const usable = iface.connected && !iface.is_virtual
            const isOn = enabled[iface.name] ?? false
            return (
              <div
                key={iface.name}
                className={`flex items-center justify-between rounded-md bg-surface-2/60 px-3 py-2 text-xs ${
                  usable ? '' : 'opacity-50'
                }`}
              >
                <label
                  className={`flex flex-1 items-center gap-2 ${
                    usable && !iface.is_default ? 'cursor-pointer' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={iface.is_default || isOn}
                    disabled={iface.is_default || !usable}
                    onChange={() =>
                      setEnabled((e) => ({ ...e, [iface.name]: !isOn }))
                    }
                    className="accent-accent"
                  />
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      iface.connected ? 'bg-success' : 'bg-muted'
                    }`}
                  />
                  <span className="font-medium text-zinc-200">{iface.name}</span>
                  {iface.is_default && (
                    <Badge variant="default" className="text-[9px]">主</Badge>
                  )}
                  {iface.is_virtual && (
                    <Badge variant="outline" className="text-[9px]">虚拟</Badge>
                  )}
                  {!iface.connected && (
                    <Badge variant="outline" className="text-[9px] text-danger">未连接</Badge>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  {iface.description && (
                    <span className="hidden max-w-[180px] truncate text-[10px] text-muted md:inline">
                      {iface.description}
                    </span>
                  )}
                  <span className="hidden font-mono text-muted md:inline">
                    {iface.ip ?? '—'}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted">权重</span>
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={weights[iface.name] ?? '1'}
                      onChange={(e) =>
                        setWeights((w) => ({ ...w, [iface.name]: e.target.value }))
                      }
                      disabled={iface.is_default || !usable || !isOn}
                      className="h-6 w-14 px-1.5 text-xs"
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          勾选要参与分流的网卡并设置权重；主网卡自动参与。保存后全局生效，
          新建下载时自动带入；未连接（无 IP）或虚拟网卡不可用。
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
            // 组装全局启用的网卡（主网卡不在此列）
            const enabledInterfaces: Record<string, number> = {}
            for (const nic of interfaces) {
              if (nic.is_default) continue
              if (nic.connected && !nic.is_virtual && enabled[nic.name]) {
                enabledInterfaces[nic.name] =
                  Math.max(1, Number(weights[nic.name]) || 1)
              }
            }
            updateSettings({
              maxConnections: Number(maxConnections) || 8,
              downloadDirectory: dir,
              enabledInterfaces,
            })
            setSaved(true)
            setTimeout(() => setSaved(false), 1500)
          }}
        >
          {saved ? '已保存 ✓' : '保存'}
        </Button>
      </div>
    </div>
  )
}
