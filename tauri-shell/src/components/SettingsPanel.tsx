import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Stepper } from './ui/stepper'
import { Switch } from './ui/switch'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog, type InterfaceSelection } from './InterfacePickerDialog'
import { listInterfaces } from '../api/daemon'
import { useStore } from '../store/useStore'

type SettingsTab = 'general' | 'downloads' | 'network' | 'about'

const TABS: { id: SettingsTab; label: string; desc: string }[] = [
  { id: 'general', label: '常规', desc: '外观与行为' },
  { id: 'downloads', label: '下载', desc: '目录与并发' },
  { id: 'network', label: '多网卡', desc: '分流加速' },
  { id: 'about', label: '关于', desc: '版本与引擎' },
]

/**
 * 权重分配公式（需求确认单 v3）：参与 N 个网卡 → 总份数 N+1
 * 主网卡占 2 份，其余各 1 份；仅主网卡时 N=1 → 100%。
 */
function sharePct(isPrimary: boolean, cardCount: number): number {
  if (cardCount <= 0) return 0
  const total = cardCount + 1 // N+1
  const parts = isPrimary ? 2 : 1
  return Math.round((parts / total) * 100)
}

/**
 * 设置页（左侧导航 + 全局保存/恢复默认 + 设置标题专门样式）：
 * 常规 / 下载 / 多网卡 / 关于。
 * - 「保存」「恢复默认」为全局按钮，作用于整个设置页（所有 Tab 的编辑态）
 * - 多网卡 Tab：参与列表 + 公式权重展示（主 2 份 / 附属 1 份）；选择入口弹窗
 */
export function SettingsPanel() {
  const { settings, updateSettings, daemon } = useStore()
  const [activeTab, setActiveTab] = useState<SettingsTab>('downloads')
  const [maxConnections, setMaxConnections] = useState(settings.maxConnections)
  const [dir, setDir] = useState(settings.downloadDirectory)
  // 自动分类（R3）：编辑态，保存时写入
  const [autoClassify, setAutoClassify] = useState(settings.autoClassify)
  // 网卡选择：局部编辑态（纯选择），保存时写入 settings
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sel, setSel] = useState<InterfaceSelection>({
    primary: settings.primaryInterface,
    enabledNames: Object.keys(settings.enabledInterfaces),
  })
  const [saved, setSaved] = useState(false)
  // 默认主网卡名（自动识别），用于外部展示
  const [autoPrimary, setAutoPrimary] = useState<string | null>(null)

  useEffect(() => {
    listInterfaces()
      .then(({ primary }) => setAutoPrimary(primary?.name ?? null))
      .catch(() => {})
  }, [])

  // 参与列表（始终含主网卡）：name → { isPrimary, pct }
  const primaryName = sel.primary ?? autoPrimary
  const rows = [
    ...(primaryName ? [{ name: primaryName, isPrimary: true }] : []),
    ...sel.enabledNames.map((name) => ({ name, isPrimary: false })),
  ]
  const cardCount = rows.length

  /** 保存整个设置页（全局） */
  const handleSave = () => {
    // enabledInterfaces：附属网卡名 → 权重份数（默认 1）
    const enabledInterfaces: Record<string, number> = {}
    for (const name of sel.enabledNames) enabledInterfaces[name] = 1
    updateSettings({
      maxConnections,
      downloadDirectory: dir,
      primaryInterface: sel.primary,
      enabledInterfaces,
      autoClassify,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  /** 恢复整个设置页默认（全局） */
  const handleReset = () => {
    setMaxConnections(8)
    setDir('')
    setAutoClassify(false)
    setSel({ primary: undefined, enabledNames: [] })
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
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'downloads' && (
            <div className="mx-auto max-w-2xl space-y-6">
              {/* 设置标题：专门样式（非 Tab 样式） */}
              <div>
                <h3 className="text-lg font-semibold text-zinc-100">下载设置</h3>
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
                <div className="h-px bg-border-subtle/60" />
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-zinc-100">自动分类</p>
                    <p className="mt-0.5 text-[11px] text-muted">按扩展名归档到子目录（视频/音频/图片/文档/压缩包），可单任务覆盖</p>
                  </div>
                  <Switch checked={autoClassify} onChange={setAutoClassify} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-zinc-100">多网卡分流</h3>
                <p className="mt-0.5 text-xs text-muted">多链路并行加速下载</p>
              </div>

              <div className="space-y-4 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-zinc-100">参与分流的网卡</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      主网卡始终参与；勾选更多已连接网卡可并行加速
                    </p>
                  </div>
                  <Badge variant={cardCount > 1 ? 'success' : 'secondary'} className="shrink-0">
                    {cardCount > 0 ? `${cardCount} 个网卡参与` : '未检测到网卡'}
                  </Badge>
                </div>

                {/* 参与列表：名称 + 角色徽章 + 权重（公式自动得出） */}
                <div className="divide-y divide-border-subtle/50 rounded-md bg-surface-2/60 px-3">
                  {rows.map((row) => (
                    <div
                      key={row.name}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-xs font-medium text-zinc-200">
                          {row.name}
                        </span>
                        {row.isPrimary && (
                          <Badge variant="default" className="shrink-0 text-[9px]">主</Badge>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className={`h-full rounded-full ${row.isPrimary ? 'bg-accent' : 'bg-success'}`}
                            style={{ width: `${sharePct(row.isPrimary, cardCount)}%` }}
                          />
                        </div>
                        <span className="w-9 text-right font-mono text-[11px] text-zinc-300">
                          {sharePct(row.isPrimary, cardCount)}%
                        </span>
                      </div>
                    </div>
                  ))}
                  {rows.length === 0 && (
                    <p className="py-3 text-xs text-muted">
                      daemon 未连接，无法枚举网卡
                    </p>
                  )}
                </div>

                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                    选择网卡
                  </Button>
                </div>

                <div className="h-px bg-border-subtle/60" />
                <p className="text-[11px] leading-relaxed text-muted">
                  权重按「网卡数 + 1」份自动分配：主网卡 2 份，其余各 1 份（例：3 个网卡 → 50% / 25% / 25%）。
                  选择入口只勾选参与网卡；保存后全局生效，新建下载自动带入。
                </p>
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-zinc-100">常规设置</h3>
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
                <h3 className="text-lg font-semibold text-zinc-100">关于</h3>
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
        </div>

        {/* 全局底部操作：作用于整个设置页（所有 Tab） */}
        <div className="border-t border-border-subtle/60 bg-surface/60 px-6 py-3">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-2">
            <p className="text-[11px] text-muted">修改仅保存后生效，作用于整个设置页</p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleReset}>
                恢复默认
              </Button>
              <Button onClick={handleSave}>{saved ? '已保存 ✓' : '保存'}</Button>
            </div>
          </div>
        </div>
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
