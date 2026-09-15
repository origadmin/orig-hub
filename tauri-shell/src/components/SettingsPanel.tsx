import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Stepper } from './ui/stepper'
import { Switch } from './ui/switch'
import { Input } from './ui/input'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog, type InterfaceSelection } from './InterfacePickerDialog'
import { AccountsPanel } from './AccountsPanel'
import { getConfig, listInterfaces, saveClassifyConfig, saveProxyConfig, verifyProxy } from '../api/daemon'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'

type SettingsTab = 'general' | 'downloads' | 'network' | 'proxy' | 'accounts' | 'about'

const TABS: { id: SettingsTab; labelKey: string; descKey: string }[] = [
  { id: 'general', labelKey: 'tab.general', descKey: 'tab.general.desc' },
  { id: 'downloads', labelKey: 'tab.downloads', descKey: 'tab.downloads.desc' },
  { id: 'network', labelKey: 'tab.network', descKey: 'tab.network.desc' },
  { id: 'proxy', labelKey: 'tab.proxy', descKey: 'tab.proxy.desc' },
  { id: 'accounts', labelKey: 'tab.accounts', descKey: 'tab.accounts.desc' },
  { id: 'about', labelKey: 'tab.about', descKey: 'tab.about.desc' },
]

/** 内置分类默认值：必须与 daemon `ClassifyConfig::defaults()` 完全对齐。
 * 分类目录名即磁盘子目录 + classify_rules 键 + 前端筛选值（规范 key），不可随意增删。
 * 旧版的 Audio/Programs/Discs/Torrents/Data/Web 与 daemon 不一致，已统一为
 * Videos/Music/Images/Documents/Archives（Others 为 daemon 兜底，不在此枚举）。 */
const BUILTIN_CLASSIFY: Record<string, string> = {
  // 视频
  mp4: 'Videos', mkv: 'Videos', avi: 'Videos', mov: 'Videos', wmv: 'Videos',
  flv: 'Videos', webm: 'Videos', m4v: 'Videos', mpg: 'Videos', mpeg: 'Videos',
  ts: 'Videos', rmvb: 'Videos',
  // 音频（daemon 规范 key = Music，无 Audio）
  mp3: 'Music', flac: 'Music', wav: 'Music', aac: 'Music', ogg: 'Music',
  m4a: 'Music', wma: 'Music', opus: 'Music', ape: 'Music',
  // 图片
  jpg: 'Images', jpeg: 'Images', png: 'Images', gif: 'Images', bmp: 'Images',
  webp: 'Images', svg: 'Images', ico: 'Images', tiff: 'Images', tif: 'Images', heic: 'Images',
  // 文档（daemon 将 csv 归入 Documents）
  pdf: 'Documents', doc: 'Documents', docx: 'Documents', xls: 'Documents',
  xlsx: 'Documents', ppt: 'Documents', pptx: 'Documents', txt: 'Documents',
  md: 'Documents', rtf: 'Documents', odt: 'Documents', epub: 'Documents', mobi: 'Documents', csv: 'Documents',
  // 压缩包（daemon 将 iso 归入 Archives）
  zip: 'Archives', rar: 'Archives', '7z': 'Archives', tar: 'Archives',
  gz: 'Archives', bz2: 'Archives', xz: 'Archives', zst: 'Archives', iso: 'Archives',
}

/** 规范分类 key 集合（与 daemon defaults 一致）。其名称是磁盘子目录名，
 * 不可在编辑器内被重命名（否则会与 daemon 分类键脱节、产生双重目录），
 * 仅以翻译标签只读展示。自定义分类（任意名称）仍可自由编辑/新增。 */
const BUILTIN_CATEGORY_KEYS = new Set<string>([
  'Videos', 'Music', 'Images', 'Documents', 'Archives', 'Others',
])

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
  const { t, language, setLanguage, supported } = useTranslation()
  const { settings, updateSettings, daemon, setError, tgEnabled, tgRunning, setTgEnabled } =
    useStore()
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
  const [proxyVerifying, setProxyVerifying] = useState(false)

  // 主题选择（直接即时生效，无需点保存）
  const themeOptions: { value: 'dark' | 'light' | 'system'; labelKey: string }[] = [
    { value: 'dark', labelKey: 'general.themeDark' },
    { value: 'light', labelKey: 'general.themeLight' },
    { value: 'system', labelKey: 'general.themeSystem' },
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

  /** 验证代理连通性（对 api.telegram.org 探测），不保存配置 */
  const verifyCurrentProxy = async () => {
    setProxyVerifying(true)
    setProxyErr(null)
    try {
      const url = proxyUrl.trim()
      const res = await verifyProxy({
        mode: proxyMode,
        ...(proxyMode === 'custom' && url ? { url } : { url: null }),
      })
      setProxyErr(
        res.ok
          ? `${t('proxy.verifyOk')}（${res.status}，${res.latency_ms}ms）`
          : t('proxy.verifyFail'),
      )
    } catch (e) {
      setProxyErr(`${t('proxy.verifyFail')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setProxyVerifying(false)
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
          <h2 className="text-base font-semibold text-fg-strong">{t('settings.title')}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t('settings.subtitle')}</p>
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
                <p className="text-[13px] font-medium">{t(tab.labelKey)}</p>
                <p className="truncate text-[10px] text-muted">{t(tab.descKey)}</p>
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
                <h3 className="text-lg font-semibold text-fg-strong">{t('downloads.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('downloads.sub')}</p>
              </div>

              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 默认下载目录：标题在上，路径框全宽（重新排版） */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">{t('downloads.dir')}</p>
                    <p className="text-[11px] text-muted">{t('downloads.dirHint')}</p>
                  </div>
                  <div className="mt-2">
                    <DirectoryPicker value={dir} onChange={setDir} placeholder={t('downloads.dirPlaceholder')} onError={setError} />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    {t('downloads.dirNote')}
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 最大连接数 */}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">{t('downloads.conn')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{t('downloads.connHint')}</p>
                  </div>
                  <Stepper value={maxConnections} onChange={setMaxConnections} min={1} max={64} />
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 自动分类：开关 + 规则编辑器（可编辑/新增后缀规则） */}
                <div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-fg-strong">{t('downloads.classify')}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {t('downloads.classifyHint')}
                      </p>
                    </div>
                    <Switch checked={autoClassify} onChange={setAutoClassify} />
                  </div>

                  {/* 分类 → 后缀 分组编辑列表 */}
                  <div className="mt-3 space-y-2">
                    {categories.length === 0 && (
                      <p className="rounded-md border border-border-subtle bg-surface-2/40 px-3 py-3 text-xs text-muted">
                        {t('downloads.noCategory')}
                      </p>
                    )}
                    {categories.map((c) => (
                      <div
                        key={c.key}
                        className="group rounded-md border border-border-subtle bg-surface-2/40 p-2.5 transition-colors hover:border-accent/30"
                      >
                        <div className="flex items-center gap-2">
                          {/* 分类名：规范 key 不可在编辑器内重命名（防与 daemon 分类键脱节），
                              内置分类以翻译标签只读展示；自定义分类仍可编辑 */}
                          {BUILTIN_CATEGORY_KEYS.has(c.category) ? (
                            <span
                              title={c.category}
                              className="w-28 shrink-0 truncate rounded border border-transparent px-1.5 py-1 text-xs font-medium text-accent"
                            >
                              {t('category.' + c.category, undefined, c.category)}
                            </span>
                          ) : (
                            <input
                              value={c.category}
                              onChange={(e) =>
                                setCategories((cs) =>
                                  cs.map((x) =>
                                    x.key === c.key ? { ...x, category: e.target.value } : x,
                                  ),
                                )
                              }
                              placeholder={t('downloads.newCatName')}
                              className="w-28 shrink-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-xs font-medium text-accent transition-colors focus:border-accent/50 focus:bg-surface focus:outline-none"
                            />
                          )}
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
                            title={t('downloads.noCategory')}
                            className="shrink-0 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <p className="mt-1 px-1.5 text-[10px] text-muted">
                          {t('downloads.catDir', {
                            name: t('category.' + c.category, undefined, c.category),
                          })}
                        </p>
                      </div>
                    ))}
                  </div>

                  {/* 新增分类行：分类名 + 后缀列表 */}
                  <div className="mt-3 rounded-md border border-dashed border-border-subtle bg-surface-2/20 p-2.5">
                    {/* 宽度由外层 wrapper 控制：Input 自带 w-full，故用 div 包裹设定
                        固定/弹性宽度，避免 w-full 与 w-28/flex-1 同场冲突（cn 无 tailwind-merge） */}
                    <div className="flex items-center gap-2">
                      <div className="w-28 shrink-0">
                        <Input
                          value={newCategory}
                          onChange={(e) => setNewCategory(e.target.value)}
                          placeholder={t('downloads.newCatName')}
                          className="font-medium"
                        />
                      </div>
                      <span className="shrink-0 text-xs text-muted">←</span>
                      <div className="min-w-0 flex-1">
                        <Input
                          value={newExts}
                          onChange={(e) => setNewExts(e.target.value)}
                          placeholder={t('downloads.newExt')}
                          className="font-mono"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') addCategory()
                          }}
                        />
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={addCategory}
                        disabled={!newCategory.trim() || !newExts.trim()}
                      >
                        {t('downloads.addCat')}
                      </Button>
                    </div>
                    <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-muted">
                      {t('downloads.addCatHint')}
                    </p>
                  </div>

                  {classifyErr && (
                    <p className="mt-1.5 text-[11px] text-danger">{t('downloads.saveError')}{classifyErr}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'network' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('network.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('network.sub')}</p>
              </div>

              <div className="space-y-4 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">{t('network.nics')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {t('network.nicsHint')}
                    </p>
                  </div>
                  <Badge variant={cardCount > 1 ? 'success' : 'secondary'} className="shrink-0">
                    {cardCount > 0 ? t('network.badge', { n: cardCount }) : t('network.noNic')}
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
                          <Badge variant="default" className="shrink-0 text-[9px]">{t('network.badgePrimary')}</Badge>
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
                      {t('network.daemonOff')}
                    </p>
                  )}
                </div>

                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                    {t('network.select')}
                  </Button>
                </div>

                <div className="h-px bg-border-subtle/60" />
                <p className="text-[11px] leading-relaxed text-muted">
                  {t('network.weightHint')}
                </p>
              </div>
            </div>
          )}

          {activeTab === 'proxy' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('proxy.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('proxy.sub')}</p>
              </div>

              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 模式选择 */}
                <div>
                  <p className="text-[13px] font-medium text-fg-strong">{t('proxy.mode')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {t('proxy.modeHint')}
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {(
                      [
                        { value: 'direct', labelKey: 'proxy.direct', descKey: 'proxy.direct.desc' },
                        { value: 'system', labelKey: 'proxy.system', descKey: 'proxy.system.desc' },
                        { value: 'custom', labelKey: 'proxy.custom', descKey: 'proxy.custom.desc' },
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
                          {t(opt.labelKey)}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted">
                          {t(opt.descKey)}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 自定义代理地址 */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">{t('proxy.addr')}</p>
                    <p className="text-[11px] text-muted">
                      {t('proxy.addrHint')}
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
                    {t('proxy.modeHint')}
                  </p>
                </div>

                {/* 测试代理连通性 / 保存 */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={proxyVerifying || proxyMode === 'direct'}
                    onClick={verifyCurrentProxy}
                  >
                    {proxyVerifying ? t('settings.saving') : t('proxy.verify')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={proxyBusy || proxyMode !== 'custom' || !proxyUrl.trim()}
                    onClick={async () => {
                      setProxyBusy(true)
                      setProxyErr(null)
                      try {
                        await persistProxy()
                        setProxyErr(t('proxy.savedApplied'))
                      } catch {
                        /* persistProxy 内部已设置错误 */
                      } finally {
                        setProxyBusy(false)
                      }
                    }}
                  >
                    {proxyBusy ? t('settings.saving') : t('proxy.saveApply')}
                  </Button>
                  {proxyErr && (
                    <p
                      className={cn(
                        'text-[11px]',
                        proxyErr.includes(t('proxy.verifyFail')) || proxyErr.includes('requires')
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
                {t('proxy.note')}
              </p>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('general.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('general.sub')}</p>
              </div>
              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                {/* 主题：卡片式选择，即时生效 */}
                <div>
                  <p className="text-[13px] font-medium text-fg-strong">{t('general.theme')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{t('general.themeHint')}</p>
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
                          {t(opt.labelKey)}
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    {settings.theme === 'system'
                      ? t('general.themeCurrent', {
                          mode: window.matchMedia?.('(prefers-color-scheme: light)').matches
                            ? t('general.themeCurrentLight')
                            : t('general.themeCurrentDark'),
                        })
                      : settings.theme === 'light'
                        ? t('general.themeCurrent', { mode: t('general.themeCurrentLight') })
                        : t('general.themeCurrent', { mode: t('general.themeCurrentDark') })}
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 语言：卡片式选择，即时生效 */}
                <div>
                  <p className="text-[13px] font-medium text-fg-strong">{t('general.language')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{t('general.languageHint')}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {supported.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setLanguage(opt.value)}
                        className={cn(
                          'rounded-lg border px-3 py-2.5 text-left text-[13px] font-medium transition-all',
                          language === opt.value
                            ? 'border-accent text-accent ring-2 ring-accent/30'
                            : 'border-border-subtle text-fg-strong hover:border-fg-soft',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 启动行为 */}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">{t('general.autoStart')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{t('general.autoStartHint')}</p>
                  </div>
                  <Switch
                    checked={settings.autoStart}
                    onChange={(v) => updateSettings({ autoStart: v })}
                  />
                </div>
                <div className="h-px bg-border-subtle/60" />
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">{t('general.notify')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{t('general.notifyHint')}</p>
                  </div>
                  <Switch
                    checked={settings.notifications}
                    onChange={(v) => updateSettings({ notifications: v })}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'accounts' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('accounts.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('accounts.sub')}</p>
              </div>

              {/* TG 可选插件：daemon 拉起/终止 orig-tg 子服务；关闭时隐藏 TG 模块 */}
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-fg-strong">{t('tg.toggle')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{t('tg.toggleHint')}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={cn(
                      'text-[11px]',
                      tgRunning ? 'text-success' : 'text-muted',
                    )}
                  >
                    {tgEnabled
                      ? tgRunning
                        ? t('tg.running')
                        : t('tg.starting')
                      : t('tg.stopped')}
                  </span>
                  <Switch
                    checked={tgEnabled}
                    onChange={(v) => {
                      setTgEnabled(v)
                    }}
                  />
                </div>
              </div>

              <AccountsPanel />
            </div>
          )}

          {activeTab === 'about' && (
            <div className="mx-auto max-w-2xl space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('about.heading')}</h3>
                <p className="mt-0.5 text-xs text-muted">{t('about.sub')}</p>
              </div>
              <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-fg-strong">{t('about.engine')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {daemon?.managed ? t('about.engineManaged') : t('about.engineExternal')}
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
                      {daemon?.alive ? t('about.alive') : t('about.dead')} · {t('about.port')} {daemon?.port ?? 9876}
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
                ? t('settings.saveHintGeneral')
                : t('settings.saveHintOther')}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleReset}>
                {t('settings.reset')}
              </Button>
              <Button onClick={handleSave} disabled={classifyBusy}>
                {classifyBusy ? t('settings.saving') : saved ? t('settings.saved') : t('settings.save')}
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
