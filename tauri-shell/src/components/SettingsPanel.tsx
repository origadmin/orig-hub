import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Stepper } from './ui/stepper'
import { Switch } from './ui/switch'
import { Input } from './ui/input'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog, type InterfaceSelection } from './InterfacePickerDialog'
import { getConfig, listInterfaces, saveClassifyConfig, saveProxyConfig } from '../api/daemon'
import { useStore } from '../store/useStore'
import { cn } from '../lib/utils'

type SettingsTab = 'general' | 'downloads' | 'network' | 'proxy' | 'about'

const TABS: { id: SettingsTab; label: string; desc: string }[] = [
  { id: 'general', label: '常规', desc: '外观与行为' },
  { id: 'downloads', label: '下载', desc: '目录与并发' },
  { id: 'network', label: '多网卡', desc: '分流加速' },
  { id: 'proxy', label: '代理', desc: 'HTTP 下载' },
  { id: 'about', label: '关于', desc: '版本与引擎' },
]

/** 内置分类默认值（daemon 侧同款；仅作 UI 展示回退） */
const BUILTIN_CLASSIFY: Record<string, string> = {
  // 视频
  mp4: 'Videos', mkv: 'Videos', avi: 'Videos', mov: 'Videos', wmv: 'Videos',
  flv: 'Videos', webm: 'Videos', m4v: 'Videos', ts: 'Videos', m3u8: 'Videos',
  // 音频
  mp3: 'Audio', flac: 'Audio', wav: 'Audio', aac: 'Audio', ogg: 'Audio',
  m4a: 'Audio', wma: 'Audio', ape: 'Audio',
  // 图片
  jpg: 'Images', jpeg: 'Images', png: 'Images', gif: 'Images', webp: 'Images',
  bmp: 'Images', svg: 'Images', ico: 'Images', heic: 'Images',
  // 文档
  pdf: 'Documents', doc: 'Documents', docx: 'Documents', xls: 'Documents',
  xlsx: 'Documents', ppt: 'Documents', pptx: 'Documents', txt: 'Documents',
  md: 'Documents', epub: 'Documents',
  // 压缩包
  zip: 'Archives', rar: 'Archives', '7z': 'Archives', tar: 'Archives',
  gz: 'Archives', bz2: 'Archives', xz: 'Archives', zst: 'Archives',
  // 安装包 / 可执行
  exe: 'Programs', msi: 'Programs', dmg: 'Programs', apk: 'Programs',
  deb: 'Programs', rpm: 'Programs', pkg: 'Programs',
  // 其它
  iso: 'Discs', img: 'Discs', torrent: 'Torrents', csv: 'Data', json: 'Data',
  xml: 'Data', sql: 'Data', log: 'Data', html: 'Web', htm: 'Web', css: 'Web', js: 'Web',
}

/** 权重分配公式（需求确认单 v3）：参与 N 个网卡 → 总份数 N+1 */
function sharePct(isPrimary: boolean, cardCount: number): number {
  if (cardCount <= 0) return 0
  const total = cardCount + 1 // N+1
  const parts = isPrimary ? 2 : 1
  return Math.round((parts / total) * 100)
}

interface CategoryRow {
  key: string
  /** 分类目录名（如 Videos） */
  category: string
  /** 后缀列表：逗号/顿号/分号分隔，可含前导点，如 "mp4,mkv,avi" */
  exts: string
}

/**
 * 设置页（左侧导航 + 全局保存/恢复默认 + 设置标题专门样式）：
 * 常规 / 下载 / 多网卡 / 关于。
 * - 「保存」「恢复默认」为全局按钮，作用于整个设置页（所有 Tab 的编辑态）
 * - 下载 Tab：默认目录全宽排版 + 自动分类规则编辑（可增删后缀规则）
 * - 多网卡 Tab：参与列表 + 公式权重展示（主 2 份 / 附属 1 份）
 */
export function SettingsPanel() {
  const { settings, updateSettings, daemon } = useStore()
  const [activeTab, setActiveTab] = useState<SettingsTab>('downloads')
  const [maxConnections, setMaxConnections] = useState(settings.maxConnections)
  const [dir, setDir] = useState(settings.downloadDirectory)
  // 自动分类（R3）：编辑态，保存时写入
  const [autoClassify, setAutoClassify] = useState(settings.autoClassify)
  /** 分类分组编辑态：key = 随机 id（新增未保存行） */
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [newExts, setNewExts] = useState('')
  // 网卡选择：局部编辑态（纯选择），保存时写入 settings
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sel, setSel] = useState<InterfaceSelection>({
    primary: settings.primaryInterface,
    enabledNames: Object.keys(settings.enabledInterfaces),
  })
  const [saved, setSaved] = useState(false)
  // 默认主网卡名（自动识别），用于外部展示
  const [autoPrimary, setAutoPrimary] = useState<string | null>(null)
  // 分类规则保存状态
  const [classifyBusy, setClassifyBusy] = useState(false)
  const [classifyErr, setClassifyErr] = useState<string | null>(null)

  // 代理配置编辑态
  const [proxyMode, setProxyMode] = useState<'direct' | 'system' | 'custom'>('direct')
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyErr, setProxyErr] = useState<string | null>(null)

  // 主题选择（直接即时生效，无需点保存）
  const themeOptions: { value: 'dark' | 'light' | 'system'; label: string }[] = [
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' },
    { value: 'system', label: '跟随系统' },
  ]

  /** 将 扩展名→分类 扁平映射转换为 分类→后缀串 分组列表（按分类名排序） */
  const toCategories = (map: Record<string, string>): CategoryRow[] => {
    const grouped = new Map<string, string[]>()
    for (const [ext, category] of Object.entries(map)) {
      if (!ext || !category) continue
      const list = grouped.get(category) ?? []
      list.push(ext)
      grouped.set(category, list)
    }
    return [...grouped.entries()]
      .map(([category, exts]) => ({
        key: category,
        category,
        exts: exts.sort((a, b) => a.localeCompare(b)).join(', '),
      }))
      .sort((a, b) => a.category.localeCompare(b.category))
  }

  /** 从 daemon 读取已持久化的分类规则（合并内置默认） */
  const loadClassify = () => {
    getConfig()
      .then((cfg) => {
        const merged = { ...BUILTIN_CLASSIFY, ...cfg.classify_rules }
        setAutoClassify(cfg.classify_enabled)
        setCategories(toCategories(merged))
      })
      .catch(() => {
        // daemon 不可达：回退内置默认展示
        setCategories(toCategories(BUILTIN_CLASSIFY))
      })
  }

  /** 从 daemon 读取代理配置 */
  const loadProxy = () => {
    getConfig()
      .then((cfg) => {
        setProxyMode(cfg.proxy?.mode ?? 'direct')
        setProxyUrl(cfg.proxy?.url ?? '')
      })
      .catch(() => {
        // daemon 不可达：保持默认直连
        setProxyMode('direct')
        setProxyUrl('')
      })
  }

  useEffect(() => {
    loadClassify()
    loadProxy()
    listInterfaces()
      .then(({ primary }) => setAutoPrimary(primary?.name ?? null))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 参与列表（始终含主网卡）：name → { isPrimary, pct }
  const primaryName = sel.primary ?? autoPrimary
  const rows = [
    ...(primaryName ? [{ name: primaryName, isPrimary: true }] : []),
    ...sel.enabledNames.map((name) => ({ name, isPrimary: false })),
  ]
  const cardCount = rows.length

  /** 保存分类规则到 daemon（运行时生效 + 持久化） */
  const persistClassify = async () => {
    setClassifyBusy(true)
    setClassifyErr(null)
    const map: Record<string, string> = {}
    for (const c of categories) {
      const category = c.category.trim()
      if (!category) continue
      // 后缀分隔：逗号 / 顿号 / 分号 / 空格均可；自动去前导点、去空项
      const exts = c.exts
        .split(/[,，;；\s]+/)
        .map((e) => e.trim().toLowerCase().replace(/^\.+/, ''))
        .filter((e) => e.length > 0)
      for (const ext of exts) map[ext] = category
    }
    try {
      const res = await saveClassifyConfig({ enabled: autoClassify, rules: map })
      setAutoClassify(res.classify_enabled)
      setCategories(toCategories(res.classify_rules))
    } catch (e) {
      setClassifyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setClassifyBusy(false)
    }
  }

  /** 保存代理配置到 daemon（运行时生效 + 持久化） */
  const persistProxy = async () => {
    setProxyBusy(true)
    setProxyErr(null)
    const url = proxyUrl.trim()
    try {
      await saveProxyConfig({
        mode: proxyMode,
        ...(proxyMode === 'custom' && url ? { url } : { url: null }),
      })
      setProxyUrl(url)
    } catch (e) {
      setProxyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProxyBusy(false)
    }
  }

  /** 保存整个设置页（全局） */
  const handleSave = async () => {
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
    await persistClassify()
    await persistProxy()
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  /** 恢复整个设置页默认（全局） */
  const handleReset = () => {
    setMaxConnections(8)
    setDir('')
    setAutoClassify(false)
    setSel({ primary: undefined, enabledNames: [] })
    setCategories(toCategories(BUILTIN_CLASSIFY))
    setProxyMode('direct')
    setProxyUrl('')
  }

  const addCategory = () => {
    const category = newCategory.trim()
    const exts = newExts
      .split(/[,，;；\s]+/)
      .map((e) => e.trim().toLowerCase().replace(/^\.+/, ''))
      .filter((e) => e.length > 0)
    if (!category || exts.length === 0) return
    setCategories((cs) => {
      const existing = cs.find((c) => c.category === category)
      if (existing) {
        // 合并进已有分类（去重）
        const cur = new Set(existing.exts.split(/[,，;；\s]+/).map((e) => e.trim().toLowerCase()))
        for (const e of exts) cur.add(e)
        return cs
          .map((c) =>
            c.category === category
              ? { ...c, exts: [...cur].sort((a, b) => a.localeCompare(b)).join(', ') }
              : c,
          )
          .sort((a, b) => a.category.localeCompare(b.category))
      }
      return [...cs, { key: `new:${Date.now()}:${category}`, category, exts: exts.join(', ') }].sort(
        (a, b) => a.category.localeCompare(b.category),
      )
    })
    setNewCategory('')
    setNewExts('')
  }

  const removeCategory = (key: string) => {
    setCategories((cs) => cs.filter((c) => c.key !== key))
  }

  return (
    <div className="flex h-full">
      {/* 左侧导航：标题置顶占满 + 导航项 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border-subtle/60 bg-surface/40">
        {/* 设置标题：置顶、占满整行 */}
        <div className="border-b border-border-subtle/60 px-4 py-4">
          <h2 className="text-base font-semibold text-fg-strong">设置</h2>
          <p className="mt-0.5 text-[11px] text-muted">配置你的体验</p>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                activeTab === tab.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-fg-mid hover:bg-surface-2/70 hover:text-fg-strong',
              )}
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
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">下载设置</h3>
                <p className="mt-0.5 text-xs text-muted">路径、并发与自动分类</p>
              </div>

              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 默认下载目录：标题在上，路径框全宽（重新排版） */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">默认下载目录</p>
                    <p className="text-[11px] text-muted">文件保存位置</p>
                  </div>
                  <div className="mt-2">
                    <DirectoryPicker value={dir} onChange={setDir} placeholder="~/Downloads" />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    留空使用系统默认下载目录；可从历史记录快速选取。
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 最大连接数 */}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">最大连接数</p>
                    <p className="mt-0.5 text-[11px] text-muted">单个任务的并发块数（1-64）</p>
                  </div>
                  <Stepper value={maxConnections} onChange={setMaxConnections} min={1} max={64} />
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 自动分类：开关 + 规则编辑器（可编辑/新增后缀规则） */}
                <div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-fg-strong">自动分类</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        按分类目录归档文件，后缀可用逗号、分号或顿号分隔
                      </p>
                    </div>
                    <Switch checked={autoClassify} onChange={setAutoClassify} />
                  </div>

                  {/* 分类 → 后缀 分组编辑列表 */}
                  <div className="mt-3 space-y-2">
                    {categories.length === 0 && (
                      <p className="rounded-md border border-border-subtle bg-surface-2/40 px-3 py-3 text-xs text-muted">
                        暂无分类，可在下方添加
                      </p>
                    )}
                    {categories.map((c) => (
                      <div
                        key={c.key}
                        className="group rounded-md border border-border-subtle bg-surface-2/40 p-2.5 transition-colors hover:border-accent/30"
                      >
                        <div className="flex items-center gap-2">
                          {/* 分类名 */}
                          <input
                            value={c.category}
                            onChange={(e) =>
                              setCategories((cs) =>
                                cs.map((x) =>
                                  x.key === c.key ? { ...x, category: e.target.value } : x,
                                ),
                              )
                            }
                            placeholder="分类目录名"
                            className="w-28 shrink-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-xs font-medium text-accent transition-colors focus:border-accent/50 focus:bg-surface focus:outline-none"
                          />
                          {/* 后缀列表（可编辑，逗号/分号/顿号分隔） */}
                          <input
                            value={c.exts}
                            onChange={(e) =>
                              setCategories((cs) =>
                                cs.map((x) =>
                                  x.key === c.key ? { ...x, exts: e.target.value } : x,
                                ),
                              )
                            }
                            placeholder="mp4, mkv, avi"
                            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-mono text-xs text-fg-strong transition-colors focus:border-accent/50 focus:bg-surface focus:outline-none"
                          />
                          <button
                            onClick={() => removeCategory(c.key)}
                            title="删除分类"
                            className="shrink-0 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <p className="mt-1 px-1.5 text-[10px] text-muted">
                          归档到子目录 <span className="font-mono text-fg-soft">{c.category || '分类名'}</span>
                        </p>
                      </div>
                    ))}
                  </div>

                  {/* 新增分类行：分类名 + 后缀列表 */}
                  <div className="mt-3 rounded-md border border-dashed border-border-subtle bg-surface-2/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        value={newCategory}
                        onChange={(e) => setNewCategory(e.target.value)}
                        placeholder="新分类名，如 Videos"
                        className="w-28 shrink-0 font-medium"
                      />
                      <span className="shrink-0 text-xs text-muted">←</span>
                      <Input
                        value={newExts}
                        onChange={(e) => setNewExts(e.target.value)}
                        placeholder="后缀，如 mp4, mkv, avi"
                        className="min-w-0 flex-1 font-mono"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addCategory()
                        }}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={addCategory}
                        disabled={!newCategory.trim() || !newExts.trim()}
                      >
                        添加分类
                      </Button>
                    </div>
                    <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-muted">
                      多个后缀用逗号/分号/顿号分隔，如：mp4, mkv；avi；rmvb。同一后缀属于多个分类时以最后保存的为准。
                    </p>
                  </div>

                  {classifyErr && (
                    <p className="mt-1.5 text-[11px] text-danger">保存失败：{classifyErr}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">多网卡分流</h3>
                <p className="mt-0.5 text-xs text-muted">多链路并行加速下载</p>
              </div>

              <div className="space-y-4 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">参与分流的网卡</p>
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
                        <span className="min-w-0 truncate text-xs font-medium text-fg-mid">
                          {row.name}
                        </span>
                        {row.isPrimary && (
                          <Badge variant="default" className="shrink-0 text-[9px]">主</Badge>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              row.isPrimary ? 'bg-accent' : 'bg-success',
                            )}
                            style={{ width: `${sharePct(row.isPrimary, cardCount)}%` }}
                          />
                        </div>
                        <span className="w-9 text-right font-mono text-[11px] text-fg-mid">
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

          {activeTab === 'proxy' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">代理设置</h3>
                <p className="mt-0.5 text-xs text-muted">HTTP 下载流量代理</p>
              </div>

              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 模式选择 */}
                <div>
                  <p className="text-[13px] font-medium text-fg-strong">代理模式</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    直连为默认；系统代理跟随环境变量（Windows 系统设置项需手动填到自定义）
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {(
                      [
                        { value: 'direct', label: '直连' },
                        { value: 'system', label: '系统代理' },
                        { value: 'custom', label: '自定义' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setProxyMode(opt.value)}
                        className={cn(
                          'rounded-lg border px-3 py-2.5 text-left transition-all',
                          proxyMode === opt.value
                            ? 'border-accent ring-2 ring-accent/30'
                            : 'border-border-subtle hover:border-fg-soft',
                        )}
                      >
                        <p
                          className={cn(
                            'text-[13px] font-medium',
                            proxyMode === opt.value ? 'text-accent' : 'text-fg-strong',
                          )}
                        >
                          {opt.label}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted">
                          {opt.value === 'direct'
                            ? '不走代理'
                            : opt.value === 'system'
                              ? '环境变量代理'
                              : '指定代理地址'}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 自定义代理地址 */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">代理地址</p>
                    <p className="text-[11px] text-muted">
                      支持 http:// 与 socks5://
                    </p>
                  </div>
                  <Input
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    placeholder="http://127.0.0.1:7897 或 socks5://127.0.0.1:1080"
                    disabled={proxyMode !== 'custom'}
                    className={cn('mt-2 w-full font-mono', proxyMode !== 'custom' && 'opacity-50')}
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    仅自定义模式生效。代理失效时任务会报错，可随时切回直连。
                  </p>
                </div>

                {/* 测试代理连通性 */}
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={proxyBusy || proxyMode !== 'custom' || !proxyUrl.trim()}
                    onClick={async () => {
                      setProxyBusy(true)
                      setProxyErr(null)
                      try {
                        // 先保存使运行时生效，再探测
                        await persistProxy()
                        setProxyErr('已保存，新下载将使用该代理')
                      } catch {
                        /* persistProxy 内部已设置错误 */
                      } finally {
                        setProxyBusy(false)
                      }
                    }}
                  >
                    {proxyBusy ? '保存中…' : '保存并生效'}
                  </Button>
                  {proxyErr && (
                    <p
                      className={cn(
                        'text-[11px]',
                        proxyErr.includes('失败') || proxyErr.includes('requires')
                          ? 'text-danger'
                          : 'text-success',
                      )}
                    >
                      {proxyErr}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-muted">
                BT / DHT 代理将在后续版本支持；当前代理仅作用于 HTTP(S) 下载（探测与分块请求同路径）。
              </p>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">常规设置</h3>
                <p className="mt-0.5 text-xs text-muted">外观与行为</p>
              </div>
              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 主题：卡片式选择，即时生效 */}
                <div>
                  <p className="text-[13px] font-medium text-fg-strong">主题</p>
                  <p className="mt-0.5 text-[11px] text-muted">界面配色方案，选择后立即生效</p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {themeOptions.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => updateSettings({ theme: opt.value })}
                        className={cn(
                          'group overflow-hidden rounded-lg border transition-all',
                          settings.theme === opt.value
                            ? 'border-accent ring-2 ring-accent/30'
                            : 'border-border-subtle hover:border-fg-soft',
                        )}
                      >
                        <div
                          className={cn(
                            'theme-swatch',
                            opt.value === 'dark'
                              ? 'theme-swatch--dark'
                              : opt.value === 'light'
                                ? 'theme-swatch--light'
                                : 'theme-swatch--dark',
                          )}
                        >
                          {opt.label}
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    {settings.theme === 'system'
                      ? '当前跟随系统：' +
                        (window.matchMedia?.('(prefers-color-scheme: light)').matches
                          ? '浅色'
                          : '深色')
                      : settings.theme === 'light'
                        ? '当前：浅色'
                        : '当前：深色'}
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 启动行为 */}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">开机自启</p>
                    <p className="mt-0.5 text-[11px] text-muted">登录系统时自动启动本应用</p>
                  </div>
                  <Switch
                    checked={settings.autoStart}
                    onChange={(v) => updateSettings({ autoStart: v })}
                  />
                </div>
                <div className="h-px bg-border-subtle/60" />
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">下载完成通知</p>
                    <p className="mt-0.5 text-[11px] text-muted">任务完成时发送系统通知</p>
                  </div>
                  <Switch
                    checked={settings.notifications}
                    onChange={(v) => updateSettings({ notifications: v })}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">关于</h3>
                <p className="mt-0.5 text-xs text-muted">版本与引擎状态</p>
              </div>
              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-fg-strong">下载引擎 (surge-daemon)</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {daemon?.managed ? '由本应用托管（sidecar）' : '外部 daemon'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full',
                        daemon?.alive ? 'bg-success' : 'bg-danger',
                      )}
                    />
                    <span className="text-fg-mid">
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
            <p className="text-[11px] text-muted">
              {activeTab === 'general'
                ? '主题与行为开关即时生效，其余修改保存后生效'
                : '修改仅保存后生效，作用于整个设置页'}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleReset}>
                恢复默认
              </Button>
              <Button onClick={handleSave} disabled={classifyBusy}>
                {classifyBusy ? '保存中…' : saved ? '已保存 ✓' : '保存'}
              </Button>
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
