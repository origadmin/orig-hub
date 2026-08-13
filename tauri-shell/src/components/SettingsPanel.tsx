import { useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog } from './InterfacePickerDialog'
import { useStore } from '../store/useStore'

export function SettingsPanel() {
  const { settings, updateSettings, daemon } = useStore()
  const [maxConnections, setMaxConnections] = useState(String(settings.maxConnections))
  const [dir, setDir] = useState(settings.downloadDirectory)
  // 网卡选择：局部编辑态，保存时写入 settings.enabledInterfaces
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selected, setSelected] = useState<Record<string, number>>(
    settings.enabledInterfaces,
  )
  const [saved, setSaved] = useState(false)

  const enabledCount = Object.keys(selected).length
  const totalWeight = Object.values(selected).reduce((a, b) => a + b, 0)

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

      {/* 多网卡分流 */}
      <section className="space-y-3 rounded-lg border border-border-subtle bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-200">多网卡分流</h3>
          <Badge variant={enabledCount > 0 ? 'success' : 'secondary'}>
            {enabledCount > 0 ? `${enabledCount} 个附加网卡` : '未启用附加网卡'}
          </Badge>
        </div>

        <div className="flex items-center justify-between rounded-md bg-surface-2/60 px-3 py-2.5">
          <div className="min-w-0 text-xs">
            {enabledCount > 0 ? (
              <p className="truncate text-zinc-300">
                {Object.entries(selected)
                  .map(([name, w]) => `${name} ×${w}`)
                  .join('、')}
              </p>
            ) : (
              <p className="text-muted">仅主网卡参与（默认）</p>
            )}
            <p className="mt-0.5 text-[10px] text-muted">
              {enabledCount > 0
                ? `权重合计 ${totalWeight}，按相对比率分配并发连接`
                : '在弹窗中勾选更多已连接网卡可并行加速'}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
            选择网卡
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted">
          主网卡始终参与；可勾选其他已连接网卡并设定权重。保存后全局生效，
          新建下载时自动带入。
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

      <InterfacePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={selected}
        onConfirm={(sel) => setSelected(sel)}
      />

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setSelected({})
            setMaxConnections('8')
            setDir('')
          }}
        >
          恢复默认
        </Button>
        <Button
          onClick={() => {
            updateSettings({
              maxConnections: Number(maxConnections) || 8,
              downloadDirectory: dir,
              enabledInterfaces: selected,
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
