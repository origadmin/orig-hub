import { useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Stepper } from './ui/stepper'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog, type InterfaceSelection } from './InterfacePickerDialog'
import { useStore } from '../store/useStore'

type SettingsTab = 'general' | 'downloads' | 'network' | 'about'

const TABS: { id: SettingsTab; label: string; desc: string }[] = [
  { id: 'general', label: '常规', desc: '外观与行为' },
  { id: 'downloads', label: '下载', desc: '目录与并发' },
  { id: 'network', label: '多网卡', desc: '分流加速' },
  { id: 'about', label: '关于', desc: '版本与引擎' },
]

/**
 * 设置页（左侧 Tab 导航，吸收 go-backup 布局）：
 * 常规 / 下载 / 多网卡 / 关于，每 Tab 用「图标+描述+控件」行式布局。
 */
export function SettingsPanel() {
  const { settings, updateSettings, daemon } = useStore()
  const [activeTab, setActiveTab] = useState<SettingsTab>('downloads')
  const [maxConnections, setMaxConnections] = useState(settings.maxConnections)
  const [dir, setDir] = useState(settings.downloadDirectory)
  // 网卡选择：局部编辑态（含主网卡），保存时写入 settings
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sel, setSel] = useState<InterfaceSelection>({
    primary: undefined,
    weights: settings.enabledInterfaces,
  })
  const [saved, setSaved] = useState(false)

  const enabledCount = Object.keys(sel.weights).length
  const totalWeight = Object.values(sel.weights).reduce((a, b) => a + b, 0)

  const handleSave = () => {
    updateSettings({
      maxConnections,
      downloadDirectory: dir,
      enabledInterfaces: sel.weights,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const handleReset = () => {
    setMaxConnections(8)
    setDir('')
    setSel({ primary: undefined, weights: {} })
  }

  return (
    <div className="flex h-full">
      {/* 左侧导航 */}
      <aside className="w-52 shrink-0 border-r border-border-subtle/60 bg-surface/40 p-3">
        <div className="px-2 pb-3 pt-1">
          <h2 className="text-base font-semibold text-zinc-100">设置</h2>
          <p className="mt-0.5 text-[11px] text-muted">配置你的体验</p>
        </div>
        <nav className="flex flex-col gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                activeTab === tab.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-zinc-300 hover:bg-surface-2/70 hover:text-zinc-100'
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{tab.label}</p>
                <p className="truncate text-[10px] text-muted">{tab.desc}</p>
              </div>
            </button>
          ))}
        </nav>
      </aside>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'downloads' && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">下载</h3>
              <p className="mt-0.5 text-xs text-muted">路径、并发与默认行为</p>
            </div>

            <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-100">默认下载目录</p>
                  <p className="mt-0.5 text-[11px] text-muted">文件保存位置，可浏览选择或从历史选取</p>
                </div>
                <div className="w-64 shrink-0">
                  <DirectoryPicker value={dir} onChange={setDir} placeholder="~/Downloads" />
                </div>
              </div>
              <div className="h-px bg-border-subtle/60" />
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-100">最大连接数</p>
                  <p className="mt-0.5 text-[11px] text-muted">单个任务的并发块数（1-64）</p>
                </div>
                <Stepper value={maxConnections} onChange={setMaxConnections} min={1} max={64} />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'network' && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">多网卡分流</h3>
              <p className="mt-0.5 text-xs text-muted">多链路并行加速下载</p>
            </div>

            <div className="space-y-4 rounded-xl border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-100">参与分流的网卡</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {enabledCount > 0
                      ? `已启用 ${enabledCount} 个附加网卡，权重合计 ${totalWeight}%（按相对比率分配并发）`
                      : '仅主网卡参与（默认）。勾选更多已连接网卡可并行加速'}
                  </p>
                </div>
                <Badge variant={enabledCount > 0 ? 'success' : 'secondary'} className="shrink-0">
                  {enabledCount > 0 ? `${enabledCount} 个附加` : '未启用'}
                </Badge>
              </div>

              {enabledCount > 0 && (
                <div className="rounded-md bg-surface-2/60 px-3 py-2.5">
                  <p className="break-all text-xs leading-relaxed text-zinc-300">
                    {sel.primary && (
                      <span className="font-medium text-accent">
                        {sel.primary}（主） +{' '}
                      </span>
                    )}
                    {Object.entries(sel.weights)
                      .map(([name, w]) => `${name} ${w}%`)
                      .join('、')}
                  </p>
                </div>
              )}

              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                  选择网卡
                </Button>
              </div>

              <div className="h-px bg-border-subtle/60" />
              <p className="text-[11px] leading-relaxed text-muted">
                主网卡可切换（默认自动识别默认路由网卡）；权重为相对比率，
                例如 60%:40% ≈ 6:4 并发分配。保存后全局生效，新建下载自动带入。
              </p>
            </div>
          </div>
        )}

        {activeTab === 'general' && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">常规</h3>
              <p className="mt-0.5 text-xs text-muted">外观与行为</p>
            </div>
            <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-zinc-100">主题</p>
                  <p className="mt-0.5 text-[11px] text-muted">界面配色方案</p>
                </div>
                <select
                  value={settings.theme}
                  onChange={(e) =>
                    updateSettings({ theme: e.target.value as 'dark' | 'light' | 'system' })
                  }
                  className="rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">关于</h3>
              <p className="mt-0.5 text-xs text-muted">版本与引擎状态</p>
            </div>
            <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-zinc-100">下载引擎 (surge-daemon)</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {daemon?.managed ? '由本应用托管（sidecar）' : '外部 daemon'}
                  </p>
                </div>
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
              </div>
            </div>
          </div>
        )}

        {/* 底部操作 */}
        {activeTab !== 'about' && (
          <div className="mx-auto mt-8 flex max-w-2xl justify-end gap-2">
            <Button variant="ghost" onClick={handleReset}>
              恢复默认
            </Button>
            <Button onClick={handleSave}>{saved ? '已保存 ✓' : '保存'}</Button>
          </div>
        )}
      </div>

      <InterfacePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={sel}
        onConfirm={(s) => setSel(s)}
      />
    </div>
  )
}
