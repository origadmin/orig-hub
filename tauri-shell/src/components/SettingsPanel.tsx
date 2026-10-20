import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Stepper } from './ui/stepper'
import { Switch } from './ui/switch'
import { Input } from './ui/input'
import { SectionCard, SectionTitle, SectionDesc } from './ui/section-card'
import { DirectoryPicker } from './DirectoryPicker'
import { InterfacePickerDialog, type InterfaceSelection } from './InterfacePickerDialog'
import { AccountsPanel } from './AccountsPanel'
import {
  getConfig,
  listInterfaces,
  saveClassifyConfig,
  saveDownloadConfig,
  saveProxyConfig,
  verifyProxy,
} from '../api/daemon'
import {
  addManagedRoot,
  getCacheClearPreview,
  getCacheStats,
  listManagedRoots,
  removeManagedRoot,
  setPrimaryManagedRoot,
  type ManagedRoot,
} from '../api/tg'
import { isTauri, copyToClipboard } from '../lib/env'
import { CacheManagerDialog } from './CacheManagerDialog'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'
import { fmtSize } from '../lib/tgmedia'
import { cn } from '../lib/utils'
import type { SettingsSection } from '../nav'

/**
 * 设置域七区块（模块重整 M0 · BUG-298 / M0-T07）。
 *
 * 权威形态：`05-ui-wireframes.md` §6「左锚点 + 右 divider 列表」。
 * 本阶段**只移动，不改读写**（tasks.md 原文）：每个控件的作用端点与保存语义
 * 逐一保持原状，变的只是它落在哪个区块。分区 id 与 `nav/index.ts::SettingsSection`
 * 同一个联合（单一真源，不另写一份枚举）。
 *
 * 与 M0 前的两处硬差异：
 *  1. 通用区**不再放 TG 控件** —— TG 的启停/状态/缓存入口连同账号区一起归
 *     「Telegram 插件」区块（入口与它的数据在同一个家）；
 *  2. 库根（媒体库根目录）**只读展示**：它是 `<下载路径>/library` 的派生值
 *     （BUG-323，用户裁定「库根跟下载走」），没有自己的写入口 —— 想改库根就改
 *     下载目录，二者不可能再分家。
 */
const SECTIONS: { id: SettingsSection; labelKey: string; descKey: string }[] = [
  { id: 'general', labelKey: 'sec.general', descKey: 'sec.general.desc' },
  { id: 'downloads', labelKey: 'sec.downloads', descKey: 'sec.downloads.desc' },
  { id: 'network', labelKey: 'sec.network', descKey: 'sec.network.desc' },
  { id: 'engine', labelKey: 'sec.engine', descKey: 'sec.engine.desc' },
  { id: 'telegram', labelKey: 'sec.telegram', descKey: 'sec.telegram.desc' },
  { id: 'share', labelKey: 'sec.share', descKey: 'sec.share.desc' },
  { id: 'about', labelKey: 'sec.about', descKey: 'sec.about.desc' },
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
 * 设置页（左侧锚点 + 全局保存/恢复默认 + 分区标题）：
 * 七区块 = 通用 / 下载与存储 / 网络与代理 / 播放引擎 / Telegram 插件 / 共享 / 关于。
 *
 * 「保存」「恢复默认」为全局按钮，作用于整个设置页（所有区块的编辑态）——
 * 端点与保存语义保持 M0 前原状（tasks.md：只移动，不改读写）。
 */
export function SettingsPanel({
  onOpenMedia,
  section,
  onSectionChange,
}: {
  onOpenMedia?: () => void
  /** 当前分区锚点（单一真源在 MainLayout 的 `nav.section`） */
  section?: SettingsSection
  /** 用户在面板内切换分区时回写真源，避免两处各存一份 */
  onSectionChange?: (s: SettingsSection) => void
} = {}) {
  const { t, language, setLanguage, supported } = useTranslation()
  const { settings, updateSettings, daemon, setError, tgService, tgLink, setTgEnabled, refreshTgState } =
    useStore()
  // 服务层（进程）与链路层（Telegram）分开（BUG-178）：开关说的是「服务在不在」，
  // 不再掺链路状态 —— 掺了就会出现「插件：运行中」与「Telegram 不可用」同屏打架。
  const tgEnabled = tgService.enabled
  const tgRunning = tgService.running
  /**
   * BUG-351：daemon 侧链路健康 + 自愈历史（唯一真源 `/api/config` 的 `tg_link`）。
   *
   * 与上面的 `tgLink`（前端自探的 Telegram 会话态）是两件事：那是「Telegram 连没连上」，
   * 这是「daemon 巡检判定的链路健康 + 它重启过 orig-tg 几次」。没有后者，界面只能
   * 看到瞬时 `running` —— 系统每 5 分钟自杀重启一次，关于页却恒绿。
   */
  const tgHealth = tgService.link ?? null
  /** epoch 秒 → 本地时钟串（「最近重启时间」用；不引额外依赖） */
  const formatClock = (epochSec: number) => {
    const d = new Date(epochSec * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const tgDown = Boolean(tgHealth?.link_down)
  /** 近期重启窗口：15 分钟内重启过 ⇒ 状态点转琥珀色（它是「莫名挂了」的直接来源） */
  const tgRecentlyRestarted =
    !!tgHealth?.last_restart_at && Date.now() / 1000 - tgHealth.last_restart_at < 900
  const [activeTab, setActiveTab] = useState<SettingsSection>(section ?? 'general')
  /**
   * 分区锚点受控同步（M0-T07）：外部（`navigate('settings',{section})`）改分区时
   * 面板跟着走。用 `!==` 比较而非无条件 setState —— 无条件 set 每次渲染都写一次，
   * 与「state 未变也要重新渲染」同义，白白打乱 memo。
   */
  useEffect(() => {
    if (section && section !== activeTab) setActiveTab(section)
  }, [section, activeTab])
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
  // 缓存清理：只读占用读数 + 「有没有可清理的东西」判据 + 清理中心开关
  const [cacheUsage, setCacheUsage] = useState<{ files: number; bytes: number } | null>(null)
  /** 孤儿字节：`stats.bytes` 只统计**条目背书**的字节，孤儿不在其中。不写出来的话
   *  「当前占用 850 MB」旁边其实还躺着 1.1 GB 可清理字节 —— 读数低估会让人错过清理。 */
  const [orphanBytes, setOrphanBytes] = useState(0)
  /** 可清理条目数（缓存条目 + 孤儿文件）。0 时入口禁用 —— 不让用户点开一个空面板 */
  const [clearableCount, setClearableCount] = useState(0)
  /**
   * 判据是否已读回。**未就绪 ≠ 无可清**：两者都是「暂时点不了」，但含义相反 ——
   * 未就绪时禁用等于在「正在读取占用…」旁边挂一个灰按钮，直接谎报「没什么可清」。
   * 所以禁用只在**读完且确实为 0** 时生效（多余的一次点击由面板内的空态承接）。
   */
  const [cacheUsageLoaded, setCacheUsageLoaded] = useState(false)
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false)

  /**
   * **受管库根**（BUG-323）= `<生效下载路径>/library` —— daemon 下发的**派生值**，
   * 页面**只读展示**：想改它就改下载目录（用户裁定「库根跟下载走」）。
   * 不再有编辑态/已保存值两份状态 —— 那正是「界面显示的库根 ≠ 引擎实际用的库根」的温床。
   */
  const [libRoot, setLibRoot] = useState('')
  /**
   * **生效下载路径**（受管根 / 权限边界）：daemon 计算下发（配置值 → 平台默认）。
   * 「当前生效」行直出它，前端不自己拼 —— 拼出来必然与引擎漂移。
   */
  const [effectiveRoot, setEffectiveRoot] = useState('')
  // 内容默认根（用户 2026-10-19 裁定「禁止往C盘写入任何数据,所有内容应该写D盘」
  // ⇒ Windows 恒 `D:\OrigDown`）：用户未显式设置时作占位/回退，
  // 杜绝写死的 ~/Downloads（Unix 风格，在 Windows 上误导）。
  const [defaultDir, setDefaultDir] = useState('')
  /**
   * 手动下载**未配置** `download_dir` 时的实际默认根 —— 由 daemon 计算下发
   * （**BUG-323 起 = 内容默认根，Windows 恒 `D://OrigDown`**）。前端**不自己拼路径**，
   * 否则默认根与别处另算一套必然漂移。下载目录输入框的占位优先用它。
   */
  const [manualRoot, setManualRoot] = useState('')
  /**
   * **受管根集合**（BUG-323 第三裁定「下载单根 / 管理多根」，Stage 2 UI）：
   * 下载根（locked，恒在）+ 用户增删的根。主根只是管理视图默认选中 ——
   * 切换主不动下载落点（R3′）。orig-tg 是唯一真源（`GET /api/fs/roots`）。
   */
  const [managedRoots, setManagedRoots] = useState<ManagedRoot[]>([])
  const [managedErr, setManagedErr] = useState<string | null>(null)
  const [managedBusy, setManagedBusy] = useState(false)
  /** 新增行的编辑态（DirectoryPicker 值）。 */
  const [newRoot, setNewRoot] = useState('')
  /**
   * 调试日志路径（BUG-243）：daemon 是唯一真源（`GET /api/config` 的 `logs`），
   * 这里只**照抄展示**，不本地拼路径 —— 引擎换目录时关于页自动跟着走。
   */
  const [logPaths, setLogPaths] = useState<{ dir: string; orig_tg: string; errors: string } | null>(
    null,
  )
  /** 网页调试模式降级提示（BUG-286）：原生入口不可用时的替代动作说明。
   *  这是**能力边界陈述**，不是错误 —— 故走 muted 内联文案，不走全局 setError。 */
  const [nativeHint, setNativeHint] = useState<string | null>(null)
  /** TG 拉起/自愈失败原因：单一真源是服务层（daemon `tg_last_error`），不另存一份 state */
  const tgError = tgService.lastError

  // 缓存占用：进设置页读一次（不轮询 —— 它只在清理前后变化，轮询是白耗）
  useEffect(() => {
    void refreshCacheUsage()
    loadManagedRoots()
  }, [])

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
    /**
     * 目录与库根的**唯一真源都在 daemon**（BUG-323）：`effective_download_root` = 受管根 /
     * 权限边界，`library_root` = 其下 `library`（派生、只读）。
     *
     * 此前这里同时读 TG 的 `libraryDir` 与 daemon 的值再「对账」，还把 TG 侧（内部 AppData）
     * 的库根回填进 daemon —— 两个进程各报一个库根、还互相写，正是「库根脱离下载路径」的
     * 来源（用户：「库根跟下载走」）。整条撤掉。
     */
    getConfig()
      .then((c) => {
        // 内容默认根：daemon 按「所有内容写 D 盘」裁定解析（Windows = D:\OrigDown），
        // 用作未显式设置时的占位/回退，替代写死的 ~/Downloads。
        setDefaultDir(c.default_download_dir ?? '')
        // 手动下载实际默认根（BUG-323）：现**就是**名义默认过禁用盘规则后的内容根
        // （Windows = D:\OrigDown），daemon 下发作唯一真源；前端不自己拼路径。
        setManualRoot(c.manual_download_root ?? '')
        setEffectiveRoot(c.effective_download_root ?? '')
        setLibRoot(c.library_root ?? '')
        // 下载目录的**唯一真源是引擎**（它决定文件实际落哪，BUG-234）：
        // 引擎值（含「空 = 未配置」）**双向**对齐本地镜像与编辑态。
        //
        // BUG-323 缺陷④：此前只写 `if (c.download_dir) { … }` —— 有值才同步，
        // 引擎为空时**保留**本地 localStorage 里的旧值 ⇒ 界面显示一个引擎根本不会
        // 使用的目录（同一屏里「当前生效」是内容默认根、输入框却写着别的路径）。
        // 判定「能不能改目录」时这条最坑：用户改了、保存了、又别处清空了引擎值，
        // 重开设置页依旧显示旧路径，看着就像「改不动」。
        const engineDir = c.download_dir ?? ''
        // BUG-356：退化路径（"/" / "." / 空）绝不在输入框回显为下载目录 —— 一律回退到
        // daemon 算出的生效根（D:\OrigDown），否则用户会在输入框看到裸根 "/"。
        const degenerate = engineDir === '/' || engineDir === '.' || engineDir === ''
        const displayDir = degenerate ? (c.effective_download_root ?? engineDir) : engineDir
        setDir(displayDir)
        updateSettings({ downloadDirectory: displayDir })
        // 调试日志路径（BUG-243）：同一份 config 里带下来，不额外打一次请求。
        if (c.logs) setLogPaths(c.logs)
      })
      .catch(() => {})
    // TG 拉起失败原因（BUG-177 / BUG-178）：服务不可用时侧栏没有 TG 入口，
    // 若这里也不说原因，用户只会以为「TG 功能没了」。走唯一刷新入口，不另拉一次 config。
    void refreshTgState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 参与列表（始终含主网卡）：name → { isPrimary, pct }
  const primaryName = sel.primary ?? autoPrimary
  const rows = [
    ...(primaryName ? [{ name: primaryName, isPrimary: true }] : []),
    ...sel.enabledNames.map((name) => ({ name, isPrimary: false })),
  ]
  const cardCount = rows.length

  /** 拉取受管根集合（低频：只在进设置页与增删改后拉，不轮询）。 */
  const loadManagedRoots = () => {
    listManagedRoots()
      .then((roots) => {
        setManagedRoots(roots)
        setManagedErr(null)
      })
      .catch((e) => {
        // orig-tg 不可达：集合拉不到 ⇒ 卡片显示原因，不假装「没有根」。
        setManagedErr(e instanceof Error ? e.message : String(e))
      })
  }

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

  /**
   * 「清除缓存文件」现在是**入口**，不是动作（BUG-059）。
   *
   * 此前点一下就把下载目录内全部缓存字节清光：粒度只有「全清」一档，
   * 于是最危险的档位被直接摆在一个按钮下面（要么不动、要么全动）。
   * 现在点击打开清理中心（落在「缓存字节」页签），先给分档预览 ——
   * 条目数与字节、孤儿文件、外部文件多少不参与 —— 由用户按档或多选后再执行。
   *
   * 清理能力只有一个家（缓存管理面板），设置页只是另一个门：两处入口两套实现
   * 必然各自漂移，最终变成「同一个动作两个说法」。
   */

  /** 拉一次缓存占用 + 可清理量（进设置页时 + 清理后各一次，不轮询） */
  const refreshCacheUsage = async () => {
    try {
      const [st, pv] = await Promise.all([getCacheStats(), getCacheClearPreview()])
      setCacheUsage({ files: st.files ?? 0, bytes: st.bytes ?? 0 })
      setOrphanBytes(pv.orphan?.bytes ?? 0)
      // 判据取「缓存条目 + 孤儿」而不是只看占用：只剩孤儿文件时占用可能显示很小，
      // 但那确实是**可清理**的字节，禁用入口等于谎报「没什么可清」。
      setClearableCount((pv.total?.count ?? 0) + (pv.orphan?.count ?? 0))
    } catch {
      setCacheUsage(null)
      setOrphanBytes(0)
      setClearableCount(0)
    } finally {
      setCacheUsageLoaded(true)
    }
  }

  /**
   * 保存下载目录到 daemon（运行时生效 + 持久化，BUG-234）。
   *
   * 此前 handleSave 只调 `updateSettings({downloadDirectory})` —— 那是**纯 localStorage**，
   * 引擎从头到尾没收到过新目录，用户改了目录下载照旧落原处。
   * 现在与分类/代理同语义：PUT 到 daemon，成功后再回写本地镜像，失败走全局错误提示。
   */
  const persistDownload = async () => {
    try {
      const r = await saveDownloadConfig({ dir: dir.trim() })
      const saved = r.download_dir ?? ''
      setDir(saved)
      updateSettings({ downloadDirectory: saved })
      // 生效路径与库根由引擎回读（库根 = `<下载路径>/library`，BUG-323）：
      // 本页只照抄，不自己拼。
      setEffectiveRoot(r.effective_download_root ?? '')
      setLibRoot(r.library_root ?? '')
      // 下载路径还要同步给 orig-tg（它管归仓落点与媒体库字节）。失败**必须被看见**
      // （BUG-167 约定），否则「界面改了、引擎没跟上」又得用户自己去猜。
      if (!r.tg_synced) {
        setError(
          r.tg_error
            ? `下载路径已保存，但 Telegram 服务未同步：${r.tg_error}`
            : '下载路径已保存，但 Telegram 服务未同步（orig-tg 不可达）',
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 受管根变更（增 / 删 / 切主，BUG-323 Stage 2）：一律以 orig-tg 回包刷新，
   * **不本地推算** —— 本地改列表而后端拒绝（如删下载根 422）会出现界面说有、
   * 引擎说无的分裂。失败原地显示原因（下载根锁定等 422 文案由后端给出）。
   */
  const runManagedRoot = async (fn: () => Promise<ManagedRoot[]>) => {
    setManagedBusy(true)
    setManagedErr(null)
    try {
      setManagedRoots(await fn())
    } catch (e) {
      setManagedErr(e instanceof Error ? e.message : String(e))
    } finally {
      setManagedBusy(false)
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

  /**
   * 网页调试模式降级（BUG-286）：没有 Tauri opener 通道 ⇒ 复制路径 + 内联提示。
   *
   * 不碰原生、不上错误 —— raw `Cannot read properties of undefined (reading 'invoke')`
   * 正是从这里被剥掉的最后一条路径（改之前：裸 `openPath` + `setError(e.message)`）。
   * `copyToClipboard` 尽力而为；复制失败也要出提示（退化成展示路径），
   * 否则按钮点了没反应，等于把报错换成了另一种沉默。
   */
  const degradeToCopyPath = async (target: string) => {
    const copied = await copyToClipboard(target)
    setNativeHint(
      copied
        ? `网页调试模式不支持打开系统文件夹，路径已复制：${target}`
        : `网页调试模式不支持打开系统文件夹，路径：${target}`,
    )
  }

  /**
   * 打开库根文件夹：桌面走 tauri opener 通道；网页调试模式降级为「复制路径 + 内联提示」（BUG-286）。
   *
   * BUG-323：目标就是 daemon 下发的派生库根（只读），不再有「编辑态 vs 已保存值」的歧义。
   */
  const openLibraryFolder = async () => {
    const target = libRoot
    if (!target) return
    if (!isTauri()) {
      await degradeToCopyPath(target)
      return
    }
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(target)
    } catch (e) {
      console.error('openPath failed', e)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 打开调试日志目录（BUG-243；同上：网页调试模式降级为「复制路径 + 内联提示」）。 */
  const openLogFolder = async () => {
    const target = logPaths?.dir
    if (!target) return
    if (!isTauri()) {
      await degradeToCopyPath(target)
      return
    }
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(target)
    } catch (e) {
      console.error('openPath failed', e)
      setError(e instanceof Error ? e.message : String(e))
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
    await persistDownload()
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
          {SECTIONS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id)
                onSectionChange?.(tab.id)
              }}
              data-testid={`settings-tab-${tab.id}`}
              data-sec={tab.id}
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
            <div className="mx-auto max-w-2xl space-y-6" data-sec="downloads">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('downloads.heading')}</h3>
                <SectionDesc>{t('downloads.sub')}</SectionDesc>
              </div>

              <SectionCard>
                {/* 默认下载目录：标题在上，路径框全宽（重新排版） */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">{t('downloads.dir')}</p>
                    <p className="text-[11px] text-muted">{t('downloads.dirHint')}</p>
                  </div>
                  <div className="mt-2" data-testid="download-dir-picker">
                    <DirectoryPicker
                      value={dir}
                      onChange={setDir}
                      placeholder={dir || manualRoot || defaultDir || t('downloads.dirPlaceholder')}
                      initialPath={dir || manualRoot || defaultDir}
                      onError={setError}
                    />
                  </div>
                  {/* 生效值显式列出：输入框为空时它只是灰色占位（看着像「已经设好了」），
                      用户会以为改不动 —— 把 daemon 实际会用的路径直出，语义只有一种。 */}
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted" data-testid="download-dir-effective">
                    {t('downloads.dirEffective')}
                    <span className="ml-1 font-mono text-fg-mid">
                      {effectiveRoot || dir || manualRoot || defaultDir || '—'}
                    </span>
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    {t('downloads.dirNote')}
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 库根（BUG-323）：`<下载路径>/library` 的**派生值** —— 只读展示。
                    刻意没有编辑入口：库根脱离下载路径在结构上就不可表达（用户裁定
                    「库根跟下载走，所有文件不允许脱离下载路径」）。想换库根 = 换下载目录。 */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">{t('downloads.libDir')}</p>
                    <p className="text-[11px] text-muted">{t('downloads.libDirHint')}</p>
                  </div>
                  <div className="mt-2 flex items-start gap-2">
                    <div
                      className="min-w-0 flex-1 truncate rounded-md border border-border-subtle bg-surface-2/40 px-3 py-2 font-mono text-xs text-fg-mid"
                      data-testid="lib-root-readonly"
                      title={libRoot}
                    >
                      {libRoot || '—'}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 px-2 text-xs"
                      disabled={!libRoot}
                      onClick={openLibraryFolder}
                      data-testid="settings-lib-open"
                    >
                      {t('downloads.openFolder')}
                    </Button>
                  </div>
                  {nativeHint && (
                    <p
                      className="mt-1.5 text-[11px] leading-relaxed text-muted"
                      data-testid="settings-lib-hint"
                    >
                      {nativeHint}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    {t('downloads.libDirNote')}
                  </p>
                </div>

                <div className="h-px bg-border-subtle/60" />

                {/* 受管目录（BUG-323 Stage 2，2026-10-19 补齐）：下载单根 /
                    管理多根。下载根 locked 只读；用户根可增删、可设主。
                    主根 = 管理视图默认选中，**不**决定下载落点、不重定向写入（R3′）。 */}
                <div data-testid="managed-roots">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-medium text-fg-strong">
                      {t('downloads.managedTitle')}
                    </p>
                    <p className="text-[11px] text-muted">{t('downloads.managedHint')}</p>
                  </div>
                  {managedErr && (
                    <p
                      className="mt-2 text-[11px] text-danger"
                      data-testid="managed-roots-error"
                    >
                      {managedErr}
                    </p>
                  )}
                  <ul className="mt-2 space-y-1.5">
                    {managedRoots.map((r) => (
                      <li
                        key={r.path}
                        className="flex flex-wrap items-center gap-2"
                        data-testid="managed-root-row"
                        data-locked={r.locked ? '1' : '0'}
                        data-primary={r.primary ? '1' : '0'}
                      >
                        <span
                          className="min-w-0 flex-1 truncate rounded-md border border-border-subtle bg-surface-2/40 px-3 py-1.5 font-mono text-xs text-fg-mid"
                          title={r.path}
                        >
                          {r.path}
                        </span>
                        {r.primary && (
                          <Badge variant="secondary" className="shrink-0">
                            {t('downloads.managedPrimaryBadge')}
                          </Badge>
                        )}
                        {r.locked && (
                          <Badge variant="default" className="shrink-0">
                            {t('downloads.managedLockedBadge')}
                          </Badge>
                        )}
                        {!r.locked && !r.primary && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 shrink-0 px-2 text-xs"
                            disabled={managedBusy}
                            onClick={() =>
                              void runManagedRoot(() => setPrimaryManagedRoot(r.path))
                            }
                            data-testid="managed-root-set-primary"
                          >
                            {t('downloads.managedSetPrimary')}
                          </Button>
                        )}
                        {!r.locked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 shrink-0 px-2 text-xs"
                            disabled={managedBusy}
                            onClick={() =>
                              void runManagedRoot(() => removeManagedRoot(r.path))
                            }
                            data-testid="managed-root-remove"
                          >
                            {t('downloads.managedRemove')}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {/* 新增：目录选择 + 添加。目录不存在也接受（先登记再导入）。 */}
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="min-w-0 flex-1" data-testid="managed-root-new-picker">
                      <DirectoryPicker
                        value={newRoot}
                        onChange={setNewRoot}
                        placeholder={t('downloads.managedAddPlaceholder')}
                        initialPath={effectiveRoot}
                        onError={setError}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      className="shrink-0"
                      disabled={managedBusy || !newRoot.trim()}
                      onClick={() => {
                        const p = newRoot.trim()
                        if (!p) return
                        setNewRoot('')
                        void runManagedRoot(() => addManagedRoot(p))
                      }}
                      data-testid="managed-root-add"
                    >
                      {t('downloads.managedAdd')}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    {t('downloads.managedNote')}
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
                      <p className="rounded-md border border-border-subtle bg-surface-2/40 px-3 py-3 text-[11px] text-muted">
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
                      <span className="shrink-0 text-[11px] text-muted">←</span>
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
              </SectionCard>
            </div>
          )}

          {activeTab === 'telegram' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="telegram">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('tg.sectionHeading')}</h3>
                <SectionDesc>{t('tg.sectionSub')}</SectionDesc>
              </div>

              {/* 启停 + 状态 + 失败原因（M0-T07：自「通用」区迁入本区块）。
                  旧注释「TG 不可用时侧栏入口被摘除」随 M0-T05 作废（入口常驻），
                  但**这里的呈现仍是必要的**：入口只负责让人进得来，原因说明仍在设置里。 */}
              <SectionCard>
                  {/* TG 模块：启停开关 + 状态 + 清理缓存（属「通用」，不归「账号」） */}
                  <div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-fg-strong">{t('tg.toggle')}</p>
                        <p className="mt-0.5 text-[11px] text-muted">{t('tg.toggleHint')}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={cn(
                            'text-[11px]',
                            // 开了却没在跑 = 拉起失败（danger），**不是**「启动中」：
                            // 旧文案在永久失败（如端口落在系统保留区）时会一直显示「启动中」，
                            // 把 daemon 的失职伪装成「再等等就好了」（BUG-177）。
                            tgEnabled && !tgRunning
                              ? 'text-danger'
                              : tgRunning
                                ? 'text-success'
                                : 'text-muted',
                          )}
                          data-testid="tg-toggle-status"
                        >
                          {tgEnabled
                            ? tgRunning
                              ? t('tg.running')
                              : t('tg.startFailed')
                            : t('tg.stopped')}
                        </span>
                        <Switch
                          checked={tgEnabled}
                          onChange={(v) => {
                            void setTgEnabled(v).then(() => {
                              // 回写后立刻取一次失败原因：拉起失败时用户需要当场看到为什么，
                              // 而不是「开关打开了但 TG 没了」。
                              void refreshTgState()
                            })
                          }}
                        />
                      </div>
                    </div>

                    {/* 失败原因可见（BUG-177）：TG 不可用时侧栏入口被摘除，
                        这里是用户唯一能知道「为什么没有 TG」的地方。 */}
                    {tgEnabled && !tgRunning && tgError ? (
                      <p
                        className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger"
                        data-testid="tg-toggle-error"
                      >
                        {t('tg.startFailedHint', { reason: tgError })}
                      </p>
                    ) : null}

                    <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-surface-2/40 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-fg-strong">
                          {t('tg.clearCacheFile')}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted">{t('tg.clearCacheFileHint')}</p>
                        {/* 占用读数与按钮同屏：释放磁盘不可逆，盲操作不可接受 */}
                        <p className="mt-0.5 text-[11px] text-muted" data-testid="clear-cache-usage">
                          {cacheUsage
                            ? t('tg.clearCacheUsage', {
                                size: fmtSize(cacheUsage.bytes),
                                n: cacheUsage.files,
                              })
                            : t('tg.clearCacheUsageUnknown')}
                          {/* 孤儿字节单独如实报出：它是**可清理**的，但不计入 stats.bytes
                              （stats 只算条目背书的字节）。漏了就是读数低估。 */}
                          {orphanBytes > 0 ? (
                            <span data-testid="clear-cache-orphan-hint">
                              {' '}
                              {t('tg.clearCacheUsageOrphan', { size: fmtSize(orphanBytes) })}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        // 无可清理内容时禁用：点开一个空面板只会让人以为功能坏了。
                        // 但**读回判据之前不禁用** —— 那时「正在读取占用…」与灰按钮同屏，
                        // 等于谎报「没什么可清」（转瞬即逝，却正是用户第一眼看到的那一帧）。
                        disabled={cacheUsageLoaded && clearableCount === 0}
                        onClick={() => setCacheManagerOpen(true)}
                        data-testid="clear-cache-files"
                        title={t('tg.ingestCleanupSection')}
                      >
                        {t('tg.clearCacheFile')}
                      </Button>
                    </div>
                  </div>
              </SectionCard>

              {/*
                账号管理区（M0-T07：原「账号」页签整体迁入）。
                `AccountsPanel` 自带布局与横幅，此处只提供容器与分区归属。
                M7（BUG-238）多账户化时数据契约预留 `account_id`，UI 仍单账户。
              */}
              {/* Account panel section: AccountsPanel owns block-level layout (BUG-313) */}
              <AccountsPanel />
            </div>
          )}

          {activeTab === 'network' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="network-nics">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('network.heading')}</h3>
                <SectionDesc>{t('network.sub')}</SectionDesc>
              </div>

              <SectionCard>
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
                    <p className="py-3 text-[11px] text-muted">
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
              </SectionCard>
            </div>
          )}

          {/*
            网络与代理 = 一个区块两块（M0-T07：原 network + proxy 两个页签合并展示，
            任务书原文「proxy+network 合并展示，存储仍各自端点」）。
            两块各自的读写端点与保存语义保持原状，未做任何合并改写。
            条件写 `'network'`：nics 块（上一段）与代理块同属这一个分区，
            同时渲染即为「合并展示」；`'proxy'` 已从分区联合里移除。
          */}
          {activeTab === 'network' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="network-proxy">
              <SectionCard>
                <SectionTitle>{t('proxy.heading')}</SectionTitle>
                <SectionDesc>{t('proxy.sub')}</SectionDesc>
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
              </SectionCard>

              <p className="text-[11px] leading-relaxed text-muted">
                {t('proxy.note')}
              </p>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="general">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('general.heading')}</h3>
                <SectionDesc>{t('general.sub')}</SectionDesc>
              </div>
              <SectionCard>
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
              </SectionCard>
            </div>
          )}

          {/*
            播放引擎区块占位（M0-T07；M5 = BUG-302 填充）。
            **只放说明、不放控件**：没有探测/安装能力时摆一排开关与下拉，等于给用户
            一堆点了不动的假控件（BUG-148：实现约束不做成常驻 UI）。
          */}
          {activeTab === 'engine' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="engine">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('engine.heading')}</h3>
                <SectionDesc>{t('engine.sub')}</SectionDesc>
              </div>
              <SectionCard gap="none">
                <p className="text-[13px] font-medium text-fg-strong">{t('engine.placeholderTitle')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{t('engine.placeholderHint')}</p>
              </SectionCard>
            </div>
          )}

          {/*
            共享区块占位（M0-T07；M6 = BUG-303 填充）。
            与侧栏「共享」域的 SharePanel 同一口径：**无控件、无请求** ——
            受管绑定面与 `/s/*` 未在 daemon 侧成立前，前端提前做只会得到一个假界面。
          */}
          {activeTab === 'share' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="share">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('share.title')}</h3>
                <SectionDesc>{t('share.comingSoon')}</SectionDesc>
              </div>
              <SectionCard gap="none">
                <p className="text-[11px] leading-relaxed text-muted">{t('share.scopeHint')}</p>
              </SectionCard>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="mx-auto max-w-2xl space-y-6" data-sec="about">
              <div>
                <h3 className="text-lg font-semibold text-fg-strong">{t('about.heading')}</h3>
                <SectionDesc>{t('about.sub')}</SectionDesc>
              </div>
              <SectionCard>
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
              </SectionCard>

              {/*
                Telegram 插件状态（BUG-233）：关于页此前只有下载引擎一项，
                TG 是可选插件却不见踪影 —— 用户想确认「TG 到底在不在跑」只能去常规页签翻开关。
                服务层（进程）与链路层（Telegram）分开呈现，与常规页签的语义一致（BUG-178）：
                「插件：运行中」与「Telegram 不可用」是两件事，不合并成一个含糊的绿点。
                这里只读状态，开关仍在「常规」页签 —— 状态与动作不重复安放。
              */}
              <SectionCard data-testid="about-tg">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-fg-strong">{t('about.tgPlugin')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {!tgEnabled
                        ? t('about.tgLinkOff')
                        : // BUG-351：daemon 判定链路不可用时同样如实说「未连接」
                          // （此前只看前端自探的会话态，daemon 重启期间两者会打架）。
                          tgDown
                          ? t('about.tgLinkNotReady')
                          : tgLink.state === 'ready'
                            ? t('about.tgLinkReady')
                            : t('about.tgLinkNotReady')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full',
                        // 判据顺序是设计的一部分：**链路 down / 近期重启过**优先于
                        // 「进程在跑」—— 反过来写（先判 running ⇒ 绿）会把重启事实
                        // 短路掉，界面重新回到「两个状态都是好的」（BUG-351 的现象）。
                        !tgEnabled
                          ? 'bg-muted'
                          : tgDown || tgRecentlyRestarted
                            ? 'bg-warning'
                            : tgRunning
                              ? 'bg-success'
                              : 'bg-danger',
                      )}
                      data-testid="about-tg-dot"
                    />
                    <span className="text-fg-mid" data-testid="about-tg-status">
                      {!tgEnabled
                        ? t('about.tgOff')
                        : !tgRunning
                          ? t('about.tgDead')
                          : tgDown
                            ? t('about.tgLinkDown')
                            : t('about.tgRunning')}
                      {tgEnabled && tgRunning && tgService.port
                        ? ` · ${t('about.port')} ${tgService.port}`
                        : ''}
                    </span>
                  </div>
                </div>
                {/*
                  BUG-351：自愈历史必须可见。daemon 巡检会在链路**连续**不可用时
                  重启 orig-tg（每次重启都会打断在传缓存任务），此前界面只有瞬时
                  `running` 快照 ⇒ 系统每 5 分钟自杀重启一次，关于页两个绿点照常亮。
                  这里直出「累计重启 N 次 · 最近 <时间>」，让「莫名挂了」有据可查。
                */}
                {tgEnabled && tgHealth?.restarts ? (
                  <p
                    className="rounded-md bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning"
                    data-testid="about-tg-restarts"
                  >
                    {t('about.tgRestarts', { n: tgHealth.restarts })}
                    {tgHealth.last_restart_at
                      ? ` · ${t('about.tgLastRestart', { at: formatClock(tgHealth.last_restart_at) })}`
                      : ''}
                    {tgHealth.reason ? ` · ${tgHealth.reason}` : ''}
                  </p>
                ) : null}
                {tgEnabled && !tgRunning && tgError ? (
                  <p
                    className="rounded-md bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger"
                    data-testid="about-tg-error"
                  >
                    {t('tg.startFailedHint', { reason: tgError })}
                  </p>
                ) : null}
                            </SectionCard>

              {/*
                调试日志（BUG-243）：把**日志路径**摆到关于页，出错时用户照路径就能查，
                不必问「日志在哪」——「无法检查」本身就是故障不可解的一半原因。
                路径全部来自 daemon `/api/config` 的 `logs`（唯一真源），前端不拼路径。
                性能约束（用户明确要求）：日志只写**启动/失败**两类事件，不逐请求落盘，
                因此不影响下载与播放；单文件超 8 MiB 滚动一代，不做无限追加。
              */}
              <SectionCard data-testid="about-logs">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg-strong">{t('about.logs')}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{t('about.logsHint')}</p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={openLogFolder}
                    disabled={!logPaths?.dir}
                    data-testid="about-logs-open"
                  >
                    {t('about.logsOpen')}
                  </Button>
                </div>
                <p
                  className="break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-[11px] text-fg-mid"
                  data-testid="about-logs-dir"
                >
                  {logPaths?.dir ?? t('about.logsUnavailable')}
                </p>
                {nativeHint && (
                  <p
                    className="mt-1.5 text-[11px] leading-relaxed text-muted"
                    data-testid="about-logs-hint"
                  >
                    {nativeHint}
                  </p>
                )}
                <ul className="space-y-1 text-[11px] text-muted">
                  <li>
                    <span className="font-mono text-fg-mid">orig-tg.log</span> ·{' '}
                    {t('about.logsOrigTg')}
                  </li>
                  <li>
                    <span className="font-mono text-fg-mid">errors.log</span> ·{' '}
                    {t('about.logsErrors')}
                  </li>
                </ul>
                            </SectionCard>
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
              <Button onClick={handleSave} disabled={classifyBusy} data-testid="settings-save">
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

      {/*
       * 清理中心：设置页只是**入口**，落在「缓存字节」页签（BUG-059）。
       * 清理能力只此一份实现 —— 设置页与缓存管理面板共享同一个面板，
       * 两处各写一套必然漂移成「同一个动作两个说法」。
       */}
      {cacheManagerOpen ? (
        <CacheManagerDialog
          initialView="bytes"
          onClose={() => setCacheManagerOpen(false)}
          onTasksChanged={() => void refreshCacheUsage()}
          onOpenMedia={onOpenMedia}
        />
      ) : null}
    </div>
  )
}
