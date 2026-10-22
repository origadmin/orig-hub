import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './ui/button'
import { SelectAllButtons, SelectionBar } from './ui/selection-bar'
import { Input } from './ui/input'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import {
  deleteMediaItem,
  deleteEpisode,
  createTag,
  deleteSeries,
  findMediaItemIdByRef,
  getLibraryStats,
  getMediaItem,
  listMediaItems,
  listSeries,
  listTags,
  mediaItemUrl,
  mediaListParams,
  patchMediaItem,
  patchSeries,
  setItemTags,
  setSeriesTags,
} from '../api/media'
import { deleteFile, listFiles } from '../api/files'
import type { FileFact } from '../api/files'
import { subscribeEvents } from '../api/daemon'
import { loadSeriesDetail, isSeriesNotFound } from '../hooks/useSeriesDetail'
import { cacheKey, cached, invalidateCache } from '../lib/fetchCache'
import { seriesLabel } from '../lib/displayTitle'
import type {
  LibraryStats,
  MediaItem,
  MediaKind,
  MediaListQuery,
  MediaSeries,
  MediaSeriesDetail,
  MediaTag,
} from '../api/media'
import { MediaCard } from './media/MediaCard'
import { FileListView } from './media/FileListView'
import { SeriesDetail } from './media/SeriesDetail'
import { SeriesCard } from './media/SeriesCard'
import { ImportDialog } from './media/ImportDialog'
import { BulkTagDialog, TagManagerDialog } from './media/TagManagerDialog'
import { AddToSeriesDialog, CreateSeriesDialog, MergeSeriesDialog, MergeSeriesMultiDialog } from './media/SeriesDialog'
import { ExportPreviewDialog } from './media/ExportPreviewDialog'
import { OrganizeWizard } from './media/OrganizeWizard'
import { ItemEditDialog } from './media/ItemEditDialog'
import {
  fmtSize,
  isRawFileName,
  canRecacheFromSource,
  recacheFromSource,
  hasMediaBytes,
  probeLibraryBackend,
  ensureLibraryBackend,
  probeRecacheBackends,
  ensureSourceBackend,
  sourceLabelKey,
} from '../lib/mediaSources'
import type { ViewerItem } from '../types'
import {
  fileCategoryOf,
  libraryGroupOf,
  seriesIdOf,
  seriesMode,
  type FileMode,
  type SidebarCounts,
} from '../nav'

type Tab = 'all' | MediaKind
type View = 'items' | 'series' | 'seriesDetail'

/**
 * 文件域树选择（M0-T03，来自 `nav/index.ts`）。
 *
 * **受控/非受控两用**：`fmode` 缺省（老调用方，如直接渲染本面板的路径）= 面板自管导航态；
 * 传入 = 侧栏树是导航单一真源，本面板只保留数据态。
 * 之所以不做成「纯受控」：M0 的边界是**搬运不改写**，把 1850 行里的导航 setter 全部
 * 改成 props 回调属于重写，风险不在本阶段承担（那属于 M2 的「拆成 Contents/Series/Tags
 * 三视图」）。受控同步只新增一条 effect，不动任何数据流。
 */
interface Props {
  fmode?: FileMode
  onFmodeChange?: (m: FileMode) => void
  /** 侧栏树的事实计数上报（M0-T01）：徽标数必须与面板里的数是同一个数 */
  onCounts?: (c: SidebarCounts) => void
  /**
   * 「在 TG 中查看」（BUG-305）：切到 TG 域的应用内出口。
   * 由 MainLayout 经 FilesPanel 接线（域间只走 `navigate()`，组件不直改 view）。
   */
  onOpenTg?: () => void
}

const PAGE = 120

/* ── 左栏（Navi）规模上限（BUG-259）─────────────────────────────────────────
 * 左栏**不是**滚动容器：剧集与标签都必须截断到固定条数，否则矮窗口下会与 `nav`
 * 自身形成「两条同时生效且嵌套」的滚动条（小滚动条无条件禁止）。
 * 完整列表各有出口：剧集 → 上方「全部剧集 N」按钮；标签 → 下方展开控件。
 *
 * 取值依据（2026-10-13 CDP 注入式实测，两档视口共 12 组数据，见 BUG-259.md）：
 *   · 剧集行高 30px + gap 2px ⇒ 9 行 = 288px，正是原 `max-h-72` 容器的可见高度，
 *     即用户裁定的「剧集当前 9 合适」；
 *   · 标签行高 20px + gap 4px ⇒ 8 个 ≈ 115px（5 行），默认窗口 780 高下 nav 仍余
 *     ≈100px 不溢出；窗口高降到 ≈680 以下才出现唯一一条大滚动条（用户裁定允许）。
 */
const RAIL_TAG_LIMIT = 8

/**
 * 单个内容条目 → 播放项。
 *
 * 模块级（而非组件内箭头函数）：「去媒体库查看」的跳转焦点消费发生在 effect 里，
 * 闭包里若捕获每次渲染都新建的函数，effect 依赖要么漂移、要么只能靠禁用依赖来压住。
 * 与下面组件内的 `toViewerItems` 是同一份映射的两形态（单条 / 列表），不各写一套。
 */
function toViewerItem(i: MediaItem): ViewerItem {
  return {
    key: `media-${i.id}`,
    chatId: 0,
    messageId: i.id,
    kind: i.kind,
    caption: i.title,
    // 介绍单独下发：返回行显示标题、底部行显示介绍，两处不重复。
    description: i.description ?? null,
    src: mediaItemUrl(i.id),
    poster: i.poster ?? null,
    // 非 video 一律不挂剧集（与 `useGoLibrary` 同一口径）：图片/音频/文档永远不进
    // 剧集。`series_id` 是历史推导值，须按 kind 压成 null，防止旧照片分集数据把
    // 图片以「剧集 + 分集列表」形态打开。
    seriesId: i.kind === 'video' ? (i.seriesId ?? null) : null,
    // BUG-253：真源总时长随条目下发，播放器据此显示正确总数（不取 live 转码流的瞬时 duration）。
    duration: i.duration,
    // BUG-254：透传字节态与来源，使播放器能区分「无内容」与「解码失败」并给出重缓存入口。
    // 字节态用 `hasMediaBytes` 统一推导（TG 图片不落盘 / 后端 probe 真值 / 落盘路径兜底），
    // 不在各消费点重复判定。
    hasBytes: hasMediaBytes(i),
    ref: i.ref ?? null,
    source: i.source ?? null,
  }
}

/**
 * 媒体资料库（v0.6.0）：**用户可管理的**内容目录，替代原先只读的 TG 缓存列表。
 *
 * 结构（对齐主流媒体站）：
 *   左栏 分类/剧集/标签导航 → 主区 海报墙（内容）或 剧集墙/剧集详情
 * 能力：本地目录导入、剧集（季/集）编排、标签交叉归类、图片（图集）管理、多选批量操作。
 * 播放统一交给全局播放器页（openViewer），不在本面板内嵌。
 */
export function MediaLibraryPanel({ fmode, onFmodeChange, onCounts, onOpenTg }: Props = {}) {
  const { t } = useTranslation()
  const {
    setError,
    openViewer,
    pendingMediaFocus,
    setPendingMediaFocus,
    setPendingTgFocus,
    setFilesActions,
  } = useStore()

  // ---- 资料库后端探活（**不探 TG**：TG 只是来源之一，挂了不影响库）----
  const [alive, setAlive] = useState(false)
  const [libRetrying, setLibRetrying] = useState(false)
  /**
   * 库探活。函数体里两处 `probeLibraryBackend()` **不是重复调用**：
   * 第二处只在「第一次失败 **且** 运行在 Tauri」时才到达（先 `ensureLibraryBackend()`
   * 拉起 daemon 再复探）—— 正常路径只走第一处。二者不是同一路径上的两次，
   * 故不合并（BUG-239 根因 1 的「单次探活发两次 stats」实测来自别处，见 `loadMeta`）。
   * 探活本身走 `cached(cacheKey.libraryStats())`，与首屏徽标共用同一份 stats。
   */
  const probeLibrary = useCallback(async () => {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (await probeLibraryBackend()) {
      setAlive(true)
      return
    }
    if (!isTauri) {
      setAlive(false)
      return
    }
    setLibRetrying(true)
    try {
      await ensureLibraryBackend()
      setAlive(await probeLibraryBackend())
    } catch {
      setAlive(false)
    } finally {
      setLibRetrying(false)
    }
  }, [])
  useEffect(() => {
    void probeLibrary()
  }, [probeLibrary])

  /**
   * 库级动作上标题行（BUG-317 页面结构规范 / 任务 #9）。
   *
   * 「导入目录 / 新建剧集 / 导出 / 标签管理」是库级动作（不读选择集、任何视图
   * 都可用），按四件套规范应进**标题区右槽**（`page-primary-action` + 次级），
   * 而标题区是应用外壳的 `ContextBar`（跨子树）。对话框 state 与 `refreshAll`
   * 都在本面板，把 state 搬去 ContextBar 会打散数据局部性 —— 故走注册表：
   * 挂载时把四个 dialog-open handler 注册进 store，`ContextBar` 的 files
   * 分支读取调用；卸载注销（null ⇒ 按钮整簇不渲染，不呈现死按钮）。
   *
   * 依赖只有 `setFilesActions`（store setter，引用恒定）：四个 handler 闭包
   * 捕获的都是 `useState` setter（同样恒定），注册一次即终身有效。
   */
  useEffect(() => {
    setFilesActions({
      import: () => setImportOpen(true),
      createSeries: () => setCreateOpen(true),
      export: () => setExportOpen(true),
      manageTags: () => setTagMgrOpen(true),
    })
    return () => setFilesActions(null)
  }, [setFilesActions])

  /**
   * 来源后端存活态（S3）：**只**影响「重新缓存」入口，不影响库的浏览/管理。
   * TG 未启动 → 重缓存按钮置灰并给原因，而不是点了报错、更不是面板整体不可用。
   */
  const [sourceAlive, setSourceAlive] = useState<Record<string, boolean>>({})
  useEffect(() => {
    // 只在**库可用之后**探来源：库都没起，探来源没有意义，且 `alive` 从 false
    // 出发时那次探测纯属白发（BUG-239 根因 4 —— 它使 `alive` 每次翻转都重发
    // `/api/tg/diag`）。加上 `if (!alive) return`，effect 只在「进入 alive」时
    // 跑一次；存活态本身再由 `cached(cacheKey.tgDiag())` 复用，切走再回也不重发。
    if (!alive) return
    let stop = false
    void probeRecacheBackends().then((m) => {
      if (!stop) setSourceAlive(m)
    })
    return () => {
      stop = true
    }
  }, [alive])

  // ---- 数据 ----
  /**
   * 库级统计。**两个口径必须分清**（BUG-125 / BUG-133）：
   *
   * | 字段 | 口径 | 界面角色 |
   * |---|---|---|
   * | `diskBytes` | 磁盘真值（本机实际落盘字节） | **主口径**，清缓存后会下降 |
   * | `totalSize` | 登记值（`SUM(size)`，源头大小） | 次口径，仅作对照展示 |
   *
   * 此前只展示 `totalSize` 且无标注，用户清缓存后发现数字不动 → 误判「没删成功」
   * （字节其实已经回收，是展示口径在骗人）。
   *
   * 后端先于本次修复时可能不下发磁盘口径字段，故三个字段都按可选处理：
   * 缺失时**不伪造** 0，而是回退到登记值并明确标注它是什么口径 ——
   * 宁可显示「登记值」，也不显示一个没有来源的「0 字节」。
   */
  type LibraryStatsView = LibraryStats & {
    diskBytes?: number
    onDiskItems?: number
    diskBytesTruncated?: boolean
  }

  const [stats, setStats] = useState<LibraryStatsView | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [series, setSeries] = useState<MediaSeries[]>([])
  /** 无条件剧集总数（「全部剧集」徽标）——与 `series` 分开：后者可能被标签筛过。 */
  const [seriesTotal, setSeriesTotal] = useState(0)
  const [tags, setTags] = useState<MediaTag[]>([])
  const [detail, setDetail] = useState<MediaSeriesDetail | null>(null)
  const [loading, setLoading] = useState(false)

  // ---- 视图状态 ----
  const [tab, setTab] = useState<Tab>('all')
  /** 落地视图 = 剧集墙：剧集是一级实体，内容挂在它下面（见左栏层级说明）；
   *  视频库（锁定类型）直接落在内容网格——它是「按类型管的库」，不是剧集墙。 */
  const [view, setView] = useState<View>('series')
  const [activeSeriesId, setActiveSeriesId] = useState<number | null>(null)
  const [activeTagId, setActiveTagId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'oldest' | 'title' | 'duration' | 'size'>('recent')
  /* 左栏标签区（BUG-259）：默认收起 —— 只显示片数最多的 RAIL_TAG_LIMIT 个；
     展开后显示全部并出现过滤框。 */
  const [tagExpanded, setTagExpanded] = useState(false)
  const [tagFilter, setTagFilter] = useState('')

  /**
   * 侧栏分类（6 类）→ 资料库 kind（4 值）的映射。
   *
   * ⚠ **`doc`/`archive`/`other` 三落 `file` 是设计基础违反的症状，不是可接受
   * 过渡态**（2026-10-15 用户裁定，BUG-299 critical）：侧栏六分类来自文件世界的
   * 分类法（`nav::FILE_CATEGORIES`），而当前唯一数据源 `media_item` 的 `MediaKind`
   * 只有 4 值 ⇒ 这三个树子项显示**同一份内容**，而共识（D1/D13 + README §FileFact
   * 「受管字节的通用记录」）要求文件域对全部类型共通兼容。区分靠文件事实层给出
   * 非媒体文件行（BUG-299 / M2-T02），**不是**「M0 期先这样」。
   * 本映射只保证「点了不报错」，任何人不得把它读作既定正确态。
   */
  const CATEGORY_TO_KIND: Record<string, Tab> = {
    video: 'video',
    music: 'audio',
    image: 'photo',
    doc: 'file',
    archive: 'file',
    other: 'file',
  }

  /**
   * 导航受控同步（M0-T03）：侧栏树 → 本面板的导航态。
   *
   * 只写 state、**不发请求**（加载由既有的 `view`/`tab`/`activeTagId` effect 触发）；
   * `appliedFmode` 记录「已应用」，避免面板内部导航后回流的 fmode 重复触发加载 effect。
   * 这是**单向**的：fmode 变了才应用；面板内部导航不写 fmode，由各回调经
   * `onFmodeChange` 上报（见 openSeries / series-back / 未归档勾选）。
   */
  const appliedFmode = useRef<FileMode | null>(null)
  useEffect(() => {
    if (!fmode || appliedFmode.current === fmode) return
    appliedFmode.current = fmode
    const sid = seriesIdOf(fmode)
    if (sid !== null) {
      setActiveSeriesId(sid)
      setView('seriesDetail')
      return
    }
    setDetail(null)
    setActiveSeriesId(null)
    /*
     * 资料库组只剩「剧集」（BUG-304 / D18）。
     * 原 `lib === 'tags'` 分支与 `lib === 'series'` 落同一视图，是**空转入口**（已删）；
     * 原 `lib === 'unfiled'` 会把 items 视图切成「只看散片」——「未归档」状态本身取消，
     * 因为**视频=剧集**（单集即单集剧集），「有条目无剧集归属」是缺陷症状而非正常态。
     */
    if (libraryGroupOf(fmode) === 'series') {
      setView('series')
      return
    }
    const cat = fileCategoryOf(fmode)
    setView('items')
    setTab(cat ? CATEGORY_TO_KIND[cat] : 'all')
  }, [fmode])

  /**
   * 侧栏树的事实计数上报（M0-T01）。
   *
   * 侧栏徽标要的是**同一个数**（BUG-125 / BUG-133 的同源纪律：不许两处各算一套）。
   * 只在取值变化时上报，避免每次渲染都往顶层推 state。
   *
   * 「未归档」计数随状态取消一并移除（BUG-304 / D18）—— 原来它是**留空**的
   * （`LibraryStats` 无该字段，拿分页列表长度当总数属于编造），现在连侧栏那一项都不存在了，
   * BUG-298 残余②「未归档计数缺位」由此关闭。
   */
  const countsKey = `${stats?.items ?? ''}|${seriesTotal}|${stats?.tags ?? ''}`
  useEffect(() => {
    if (!onCounts) return
    onCounts({
      files: stats?.items ?? 0,
      series: seriesTotal,
      tags: stats?.tags ?? 0,
    })
    // countsKey 是上面三个值的组合：变了的才推（eslint 需要显式依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCounts, countsKey])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /**
   * 剧集墙的多选（BUG-186）：装的是**剧集 id**。
   *
   * **独立**于上面的 `selected`（它装 item id、属 items 视图 —— BUG-153/BUG-155 的既有裁定）。
   * 两者互不干扰：剧集墙的选择不会撑起 items 工具栏，items 的「全选本页」也不会碰它。
   */
  const [selectedSeries, setSelectedSeries] = useState<Set<number>>(new Set())
  /** 剧集收 video / photo（图片是浏览位内容）——全都不是 audio/未知类型才放行。 */
  const selectedJoinable =
    selected.size > 0 &&
    [...selected].every((id) => {
      const k = items.find((i) => i.id === id)?.kind
      return k === 'video' || k === 'photo'
    })

  // ---- 弹窗 ----
  const [importOpen, setImportOpen] = useState(false)
  const [tagMgrOpen, setTagMgrOpen] = useState(false)
  // 导出预览（P5）：只读完备性校验，不做导出本体（P6）
  const [exportOpen, setExportOpen] = useState(false)
  /**
   * 剧集批量导出的**预勾选**（BUG-214）。
   *
   * `null` = 不预勾选（对话框自选全库，既有行为）；数组 = 只勾这几条。
   * **不能**把传入的 `series` 换成选中子集来「实现」预勾选 —— 对话框里
   * `ids.length === series.length ? undefined : ids` 是「全选 ⇔ 全库」短路，
   * 换成子集会让「子集全选」被误判成全库导出（危险的语义错误）。
   */
  const [exportPreselect, setExportPreselect] = useState<number[] | null>(null)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  /** 剧集墙批量打标对话框（BUG-214 P1）：与 items 的 `bulkTagOpen` 并列，互不干扰。 */
  const [bulkSeriesTagOpen, setBulkSeriesTagOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [addToOpen, setAddToOpen] = useState(false)
  /** 批量整理向导（D24-A / BUG-311）：mp3tag 式模板命名 / 归位，作用于 items 多选集 */
  const [organizeOpen, setOrganizeOpen] = useState(false)
  /** 「合并到…」对话框（把另一个剧集并入当前打开的剧集） */
  const [mergeOpen, setMergeOpen] = useState(false)
  /** 剧集墙多选合并对话框（BUG-186）：把选中的多条剧集合并为一条 */
  const [mergeMultiOpen, setMergeMultiOpen] = useState(false)
  const [editing, setEditing] = useState<MediaItem | null>(null)
  /**
   * 删除确认（唯一状态机，单条与批量共用）。
   *
   * `ids` 是**显式目标集**：卡片上的逐条删除与工具栏的批量删除走同一条确认路径，
   * 区别只在目标集从哪来 —— 避免两套删除流程各写一遍（BUG-057）。
   */
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'items'; ids?: number[] }
    | { kind: 'series'; id?: number; ids?: number[] }
    // BUG-299 M2-T00a：受管下载成品（file facts）删除。ids 可能混入合成 id，
    // 执行路径按行上是否带 `fileFact` 标记分派（见 doDeleteItems）。
    | { kind: 'files'; paths: string[] }
    | null
  >(null)
  /**
   * 受管下载根成品（BUG-299 M2-T00a）——与 `items`（已登记媒体）**并列的另一个
   * 数据源**，不是它的替代：文件域父行（cat-all）= 两者的并集（按绝对路径去重）。
   *
   * 为什么不走「完成即入库」：那要跨进程写 orig-tg 的库（M2-T01b，需 BUG-172
   * 或等价决策）；读通路没有该依赖，且用户手动放入受管根的文件同样算成品
   * （出口判据 8）——读端点是严格更强的项。
   */
  const [downloadFiles, setDownloadFiles] = useState<FileFact[]>([])

  // ---------- 加载 ----------
  const loadMeta = useCallback(async () => {
    try {
      // 三份数据**都**走 `fetchCache`（BUG-239）：stats 同时是 `probeLibraryBackend`
      // 的探活判据、tags 同时被批量打标对话框读，只有全部走 cached() 才谈得上
      // 「同一份数据一次会话只拉一次」——否则未走缓存的那两份会绕过在途合并，
      // 严格模式双调用 / 探活 + 首屏各拉一遍，就是用户看到的成倍请求。
      const [s, tg, sr] = await Promise.all([
        cached(cacheKey.libraryStats(), () => getLibraryStats()),
        cached(cacheKey.tagList(), () => listTags()),
        cached(cacheKey.seriesList(null), () => listSeries()),
      ])
      setStats(s)
      setTags(tg)
      // `series` 是**当前显示**的（可能被标签筛过），故这里只取无条件总数当徽标，
      // 不覆盖列表 —— 否则「按标签筛剧集」会被无条件结果冲掉。
      setSeriesTotal(sr.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setError])

  /**
   * 标签写操作（新建 / 重命名 / 删除）后的统一收尾。
   *
   * 标签列表与 `stats.tags` 都变了，必须**先作废再重取** —— `fetchCache` 不做
   * 时间过期，不失效就会把改动前那一份读回来（表现为「刚建的标签不见了」）。
   * 新建标签的四处入口（剧集内页 / 两种批量打标 / 内容编辑）与标签管理都走这里，
   * 避免各写一份、漏掉一处（BUG-239 的失效纪律）。
   *
   * **条目列表也必须一并作废**（BUG-138）：每个 `MediaItem` 自带 `tags[]`，
   * 卡片直接渲染它（`MediaCard` 的 TagToken）。故标签一改，**已缓存的列表就是旧的**
   * ——「重命名了标签，卡片上还挂着旧名」。这里按前缀一次清掉所有筛选组合的列表缓存：
   * 调用点记得住的是「我改了标签」，记不住此刻哪些筛选组合进了缓存。
   */
  const refreshTags = useCallback(async () => {
    invalidateCache(cacheKey.tagList())
    invalidateCache(cacheKey.libraryStats())
    invalidateCache(cacheKey.mediaListPrefix())
    await loadMeta()
  }, [loadMeta])

  /**
   * 条目列表读缓存（BUG-138）。
   *
   * 此前每次进出 items 视图都发真请求 —— 同一面板里 stats / tags / 剧集列表都有读缓存，
   * 唯独最高频消费的条目列表没有，用户看到的症状是「来回切视图网络一直在转」。
   * `cached()` 同时给出**在途合并**（同键并发只发一次，含 React 严格模式 effect 双调用）
   * 与**结果缓存**（切走再回命中）。
   *
   * 键由 `mediaListParams(query)`（`listMediaItems` 内部发请求用的同一个函数）产出，
   * 不在调用方手拼：手拼的键与真正的 URL 是两份真相，改一处忘另一处就会
   * 「命中了但显示另一批数据」，且不报错。
   *
   * **不做时间过期**（fetchCache 既有裁定）：随机过期会让「刚改完又看到旧值」间歇出现。
   * 代价由显式失效兜住 —— 见 `refreshTags` / `refreshAll` / `recacheItem` / `onRemoveEpisode`。
   */
  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const query: MediaListQuery = {
        kind: tab === 'all' ? '' : tab,
        q: search.trim() || undefined,
        tagId: activeTagId ?? undefined,
        // BUG-304 / D18：文件域是「真的内容」—— 只列已落盘条目。
        // 过滤在服务端（见 `MediaListQuery.hasBytes` 的说明），与 `total` 同源。
        hasBytes: true,
        sort,
        limit: PAGE,
        offset: 0,
      }
      const r = await cached(cacheKey.mediaList(mediaListParams(query)), () =>
        listMediaItems(query),
      )
      setItems(r.items)
      setTotal(r.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [tab, search, activeTagId, sort, setError])

  const loadSeries = useCallback(async () => {
    try {
      const list = await cached(cacheKey.seriesList(activeTagId), () => listSeries(activeTagId))
      /*
       * BUG-304 / D18：文件域只列**有内容**的剧集。
       * 判据是 `hasBytes`（后端：至少一个分集条目已落盘），不是 `coverHasBytes`
       * ——后者只看封面那一条，「封面是张没缓存的图、正片全在」会被误杀。
       *
       * 老后端不下发 `hasBytes`（undefined）⇒ **不过滤**：字段缺失不等于「没有字节」，
       * 因缺字段把整库清空比多显示几条危险得多（同 `coverHasBytes` 的兼容策略）。
       */
      const visible = list.filter((s) => s.hasBytes !== false)
      setSeries(visible)
      // 无筛选时「显示数 == 总数」，顺手校正徽标（新增/删除剧集后不必整页刷新）。
      // 徽标与列表**同源**（BUG-125 / BUG-133：不许两处各算一套）。
      if (activeTagId == null) setSeriesTotal(visible.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [activeTagId, setError])

  useEffect(() => {
    if (!alive) return
    void loadMeta()
  }, [alive, loadMeta])

  useEffect(() => {
    if (!alive || view !== 'items') return
    const h = setTimeout(() => void loadItems(), 250)
    return () => clearTimeout(h)
  }, [alive, view, loadItems])

  /**
   * 受管成品读取（M2-T00a）：**只在文件域父行（cat-all）拉**。
   *
   * daemon 不可达（栈没起）时不清空媒体列表、也不抛到用户脸上——媒体条目照常
   * 展示，下载成品那一侧就是空的；错误只落到 error 通道（与 `loadItems` 同立场）。
   */
  const loadDownloadFiles = useCallback(async () => {
    try {
      const r = await listFiles()
      setDownloadFiles(r.files)
    } catch (e) {
      setDownloadFiles([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setError])

  useEffect(() => {
    if (!alive || view !== 'items' || tab !== 'all') return
    void loadDownloadFiles()
  }, [alive, view, tab, loadDownloadFiles])

  /**
   * **下载↔文件域联动**（用户 2026-10-15 报「入库流水线和下载仍然没有联动」）：
   * 订阅 daemon SSE，下载完成/删除即刷新受管成品枚举 —— 用户在文件管理里
   * **看着下载完成、行自己出现**，不必手动切视图/刷新。
   *
   * 复用现有 `/api/events` 通道（下载域已在用），不新建轮询、不新建 SSE。
   */
  useEffect(() => {
    if (!alive || view !== 'items' || tab !== 'all') return
    return subscribeEvents(({ event }) => {
      if (event === 'completed' || event === 'deleted') void loadDownloadFiles()
    })
  }, [alive, view, tab, loadDownloadFiles])

  // 剧集列表跟随标签筛选：`loadSeries` 依赖 `activeTagId`，故切换标签即自动重取。
  // 这让 TG 自动归档到剧集的 `#标签` 真正可用（此前标签只能筛「内容」，筛不到剧集）。
  useEffect(() => {
    if (!alive || view !== 'series') return
    void loadSeries()
  }, [alive, view, loadSeries])

  const openSeries = useCallback(
    async (id: number) => {
      try {
        const d = await loadSeriesDetail(id)
        setDetail(d)
        setActiveSeriesId(id)
        setView('seriesDetail')
        // 上报侧栏树（M0-T03）：下钻是**导航**，单一真源在 nav state。
        appliedFmode.current = seriesMode(id)
        onFmodeChange?.(seriesMode(id))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 剧集已被删除/合并：清掉死缓存、退回剧集墙并给语义提示，而不是卡在 404。
      if (isSeriesNotFound(e)) {
        invalidateCache(cacheKey.seriesDetail(id))
        // 必须同时作废「剧集列表」缓存：loadSeries 走的是 cached(seriesList(tag))，
        // 只清 detail 缓存的话它会命中旧列表、墙仍残留死卡（BUG-159 复现关键）。
        invalidateCache(cacheKey.seriesList(activeTagId))
        invalidateCache(cacheKey.seriesList(null))
        // 条目列表同样作废（BUG-138）：剧集被删/被合并后，挂在它下面的条目
        // 在列表里的 `seriesId` / `seriesTitle` 也随之变化。
        invalidateCache(cacheKey.mediaListPrefix())
        setDetail(null)
        setActiveSeriesId(null)
        setView('series')
        appliedFmode.current = 'lib-series'
        onFmodeChange?.('lib-series')
        void loadSeries()
        setError(t('media.seriesGone'))
        return
      }
      setError(msg)
    }
  },
  [activeTagId, setError, t, loadSeries],
)

  // ---------- 播放（交给全局播放器页）----------
  /** 内容条目 → 播放项；带 seriesId 的条目会让播放器挂出分集列表 */
  const toViewerItems = (list: MediaItem[]): ViewerItem[] => list.map(toViewerItem)

  /**
   * 分集 → 内容条目：剧集详情页入口与网格入口共用同一映射。
   *
   * 标题与介绍**直接取分集字段**：后端已把分集的 `title`/`description` 收敛为
   * 「它指向条目的那一份」（分集只表示位置）。这里不再做 `ep.title || ep.itemTitle`
   * 之类的兜底链 —— 那正是「同一个视频两个名字、介绍一边有一边空」的来源。
   */
  const episodesToItems = (d: MediaSeriesDetail): MediaItem[] =>
    d.episodes.map((e) => ({
      id: e.itemId,
      // BUG-254：透传真实来源与定位符，使无字节分集的「重新缓存」能定位到正确来源
      // （此前一律填 'local' / itemId，导致重缓存走错适配器）。
      source: e.source ?? 'local',
      ref: e.ref ?? String(e.itemId),
      // 原始文件名（photo--123_456）不是标题：留空交给展示层给可读占位。
      title: isRawFileName(e.title) ? '' : (e.title ?? ''),
      description: e.description ?? null,
      // **不**兜底成 'video'：后端对每条内容必下发 kind，兜底成视频会把图片静默当视频播
      // （正是「加入剧集后图片全被当视频」的成因之一）。未知类型归入 'file'，
      // 由播放器显示「不支持预览」——让异常可见，而不是伪装成可播内容。
      kind: (e.kind ?? 'file') as MediaKind,
      poster: e.poster,
      duration: e.duration,
      // BUG-254：无落盘路径；字节态由后端 probe 真值驱动，转成 bytesPresence
      // 供 `hasMediaBytes` 统一判定（与条目视图同源）。
      filePath: null,
      bytesPresence: e.hasBytes ? 'present' : e.hasBytes === false ? 'absent' : null,
      addedAt: 0,
      tags: [],
      seriesId: d.id,
      seriesTitle: d.title,
    }))

  /**
   * 打开一组条目。
   *
   * 关键：若选中项属于某个剧集，传入的列表必须扩成**整部剧集**。
   * 播放器右侧分集列表的点击是在这份列表内按 itemId 定位的，
   * 若只含一条，那些点击会全部落空（表现为「点了没反应」）。
   *
   * 注意这里传的是**全量**（图片 + 视频都含）：
   * 「播放序列只含同类内容」由 `MediaViewer` 按 kind 派生分组实现 ——
   * 点视频 → 组内只有视频（连着播）；点图片 → 组内只有图片（连着翻）。
   * **不要在这一层过滤**，否则侧栏会缺项，用户也无法从图片切回视频。
   */
  // `useCallback`：卡片 `memo` 化的前提（BUG-026）。依赖项只有 `openViewer`
  // —— 其余（`toViewerItems` / `episodesToItems` / `loadSeriesDetail`）都是纯函数或模块级导入。
  const playItems = useCallback(
    async (list: MediaItem[], index: number, title?: string) => {
      if (list.length === 0) return
      const picked = list[index]
      const sid = picked?.seriesId
      if (sid) {
        try {
          // 与剧集详情共用同一份缓存：这里刚看过的那部剧集不该再拉一次
          const d = await loadSeriesDetail(sid)
          const all = episodesToItems(d)
          const start = Math.max(0, all.findIndex((x) => x.id === picked.id))
          openViewer({ items: toViewerItems(all), index: start, title: d.title })
          return
        } catch {
          // 拉剧集失败不阻断播放：退回原列表
        }
      }
      openViewer({ items: toViewerItems(list), index, title })
    },
    [openViewer],
  )

  /** 卡片入口：按 item 定位序号（稳定引用，卡片 `memo` 才不会白做）。 */
  const openItem = useCallback(
    (item: MediaItem) => {
      /*
       * 受管成品（file fact）不进应用内播放器：它没有 `media_item` 行，
       * 播放器的一切坐标（条目 id / 媒体 URL）都不存在。双击 = 交给系统默认
       * 程序打开（视频/图片/音频/zip 一视同仁，出口判据 7 的「可打开」）。
       * web 调试模式无该通道，如实报错（同「打开目录」的立场）。
       */
      const fact = (item as MediaItem & { fileFact?: FileFact }).fileFact
      if (fact) {
        void (async () => {
          if (!('__TAURI_INTERNALS__' in window)) {
            setError(t('media.fileList.openWebUnsupported'))
            return
          }
          try {
            const { openPath } = await import('@tauri-apps/plugin-opener')
            await openPath(fact.path)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          }
        })()
        return
      }
      const idx = items.findIndex((x) => x.id === item.id)
      void playItems(items, Math.max(0, idx), item.title)
    },
    [items, playItems, setError, t],
  )

  /**
   * BUG-305：「在 TG 中查看」—— 媒体库 → TG 面板的应用内跳转（`pendingMediaFocus`
   * 的正向对应）。
   *
   * 两步：①把来源坐标设进 store 正向焦点（TgPanel 消费它：选频道 + 定位消息 +
   * 高亮）；②经 nav 契约切到 tg 域（`onOpenTg` 是 MainLayout 的唯一跨域通道，
   * 域间零直接 import —— 组件自己 `setView('tg')` 是设计原则 4 明令禁止的）。
   *
   * 稳定引用（useCallback）：`MediaCard` / `SeriesDetail` 都 memo，每次渲染新函数
   * 会让它们的浅比较白做（AGENTS.md §5）。
   */
  const viewInTg = useCallback(
    (coords: { chatId: number; messageId: number }) => {
      setPendingTgFocus(coords)
      onOpenTg?.()
    },
    [setPendingTgFocus, onOpenTg],
  )
  /** 逐条删除入口（稳定引用，同上）。 */
  const deleteItem = useCallback((item: MediaItem) => {
    // 受管成品（合成行）与媒体条目是两种删除语义：前者删**文件本体**
    // （daemon 受管根守卫内），后者删媒体行（字节联动见 doDeleteItems）。
    const fact = (item as MediaItem & { fileFact?: FileFact }).fileFact
    if (fact) {
      setConfirmDelete({ kind: 'files', paths: [fact.path] })
      return
    }
    setConfirmDelete({ kind: 'items', ids: [item.id] })
  }, [])

  /**
   * 消费「入库流水线 → 媒体库」的跳转焦点（`pendingMediaFocus` = tg ref）。
   *
   * 流水线的「去媒体库查看」**先就地起播、再切视图**：播放器是全屏覆盖层，
   * 所以用户点下去的第一眼是成品在播；切过来时播放器若还在，这里就只清标记 ——
   * 再开一次等于把用户刚打开的那一次播放顶掉（关不掉的感觉就从这儿来）。
   * 播放器已关（或由别的路径带焦点进来）时才按 ref 重新起播。
   *
   * 按 ref 现查而不是在当前页列表里找：列表受分页与筛选限制，**不在当前页不等于
   * 不在库里**；在列表里找不到的分支若一直挂着标记，会在用户翻页时突然弹一次播放。
   */
  useEffect(() => {
    if (!pendingMediaFocus) return
    const ref = pendingMediaFocus
    setPendingMediaFocus(null)
    if (useStore.getState().viewer) return
    let alive = true
    void (async () => {
      try {
        const id = await findMediaItemIdByRef('tg', ref)
        if (!alive || id == null) return
        openViewer({ items: [toViewerItem(await getMediaItem(id))], index: 0 })
      } catch {
        /* 媒体库已在此处，查不到就停在库里，不弹错 */
      }
    })()
    return () => {
      alive = false
    }
  }, [pendingMediaFocus, openViewer, setPendingMediaFocus])

  const playEpisode = (index: number) => {
    if (!detail) return
    void playItems(episodesToItems(detail), Math.max(0, index), detail.title)
  }

  /**
   * 重新缓存（BUG-080）：条目被清掉字节后**原路取回**。
   *
   * 只有 TG 来源有「原路」——`ref` 里的 `chat:msg` 就是下载地址。本地导入的文件
   * 丢了就是丢了，给一个必然失败的入口不如如实标「文件已丢失」。
   */
  const recacheItem = useCallback(
    async (item: MediaItem) => {
      // BUG-261：可缓存 = 适配器支持重取 **且 ref 非空**（引擎对 ref 缺失/为空的
      // tg 条目同样判不可缓存）。此前只看 source —— `tg` 但 ref 缺失的条目会给出
      // 一个点了必然失败的入口；且早退是静默的，必须解释原因。
      if (!canRecacheFromSource(item.source) || !item.ref) {
        setError(t('media.recacheNoRoute', { source: t(sourceLabelKey(item.source)) }))
        return
      }
      // 来源后端没起（如 TG 未启动）：先尝试拉起，拉不起就**如实告知并停手**，
      // 绝不静默失败——「点了没反应」比「点了告诉我为什么」糟得多。
      if (sourceAlive[item.source] === false) {
        try {
          await ensureSourceBackend(item.source)
          setSourceAlive((prev) => ({ ...prev, [item.source]: true }))
        } catch {
          setError(t('media.recacheUnavailable', { source: t(sourceLabelKey(item.source)) }))
          return
        }
      }
      try {
        await recacheFromSource(item.ref, item.source)
        // 重缓存会改变 `stats.totalSize`，但**完成是异步的**（这里只入队，前端没有
        // 完成回调）。作废 stats 是尽力而为：让下一次读重取，而不是把入队前那一份
        // 无限期留在缓存里（BUG-239 失效纪律）。
        invalidateCache(cacheKey.libraryStats())
        // 条目列表同样必须作废（BUG-138）：`MediaItem.bytesPresence` / `size` /
        // `filePath` 都随字节到位而变，卡片的判据是 `hasMediaBytes(item)` ——
        // 不失效则缓存里那份「无字节」会一直显示「重新缓存」按钮，字节已到位却仍像丢了。
        invalidateCache(cacheKey.mediaListPrefix())
        setError(t('media.recacheQueued'))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [setError, sourceAlive, t],
  )

  /** 重新缓存入口被阻断的原因（无可取回地址 / 来源后端不可用）；未阻断返回 null */
  const recacheBlockedReason = useCallback(
    (source: string, ref?: string | null): string | null => {
      if (!canRecacheFromSource(source)) return null
      // BUG-261：来源支持重取但 ref 缺失/为空 —— 缓存引擎没有坐标，入口必须
      // 置灰并说明原因（禁用态解释原因，不得静默；判据 4）。
      if (!ref || !ref.trim()) {
        return t('media.recacheNoRoute', { source: t(sourceLabelKey(source)) })
      }
      return sourceAlive[source] === false
        ? t('media.recacheUnavailable', { source: t(sourceLabelKey(source)) })
        : null
    },
    [sourceAlive, t],
  )

  /** 用户主动重连来源后端（TG 未启动时给一条明路，而不是死按钮） */
  const reconnectSources = useCallback(async () => {
    // `true` = 强制失效存活态缓存再探：用户点「重连」就是要拿**实时**结果，
    // 命中旧缓存会把这次点击顶回去（表现为「点了没反应」）。
    const next = await probeRecacheBackends(true)
    setSourceAlive(next)
  }, [])

  /** 当前不可用的「可重缓存来源」——只影响重新缓存，不影响浏览/管理 */
  const downSources = useMemo(
    () => Object.keys(sourceAlive).filter((s) => sourceAlive[s] === false),
    [sourceAlive],
  )
  const hasDownSource = downSources.length > 0
  const downSourceLabels = downSources.map((s) => t(sourceLabelKey(s))).join('、')

  // ---------- 选择 ----------
  // `useCallback`：卡片已 `memo` 化（BUG-026），回调每次渲染换新引用会让 memo 全落空。
  const toggleSelect = useCallback((id: number, _shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = () => setSelected(new Set())

  // ---- 剧集墙多选（BUG-186，独立于 items 的 `selected`）----
  /** 切换某条剧集的选中态（选择框 / Ctrl+Cmd 点击卡片都走这里）。 */
  const toggleSeriesSelect = useCallback((id: number) => {
    setSelectedSeries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSeriesSelection = useCallback(() => setSelectedSeries(new Set()), [])
  /**
   * 选中的剧集**对象**，按**点击顺序**（Set 插入序）排列，并**丢弃已不在列表里的 id**
   * （剧集被删/被标签筛掉时不残留幽灵项）。
   *
   * 顺序 = 点击顺序，仅用于展示；合并方向由对话框里用户**显式**选的「保留哪一条」决定，
   * **不**由这个顺序决定（BUG-186 的核心判据）。
   */
  const selectedSeriesList = useMemo(() => {
    const byId = new Map(series.map((s) => [s.id, s]))
    return [...selectedSeries]
      .map((id) => byId.get(id))
      .filter((s): s is MediaSeries => Boolean(s))
  }, [series, selectedSeries])
  /** 剧集墙「可合并」条件：选中 **≥2** 条（N 条 = 保留其一，其余并入）。 */
  const seriesMultiReady = selectedSeriesList.length >= 2
  /**
   * 剧集墙动作条可见条件（BUG-214）：选中 **≥1** 条即出现。
   *
   * 与 `seriesMultiReady` 分开是因为两者语义不同：合并需要 ≥2（一条没法合并），
   * 而删除 / 打标 / 导出对 1 条同样成立 —— 旧实现拿「可合并」当动作条开关，
   * 于是选中 1 条时连删除都点不到（用户复报原话：「批量不应该只有合并，删除，
   * 等等其他基础功能也必须支持」）。合并按钮在 <2 时 disabled 并给出原因。
   */
  const seriesBulkReady = selectedSeriesList.length > 0
  /** 离开剧集墙视图时清空剧集选择（与 items 的 scope 重置同一意图）。 */
  useEffect(() => {
    if (view !== 'series') setSelectedSeries((prev) => (prev.size > 0 ? new Set() : prev))
  }, [view])

  /**
   * 选择集的**作用域身份**（BUG-155）。
   *
   * `selected` 装的是 item id，而列表随「视图 / 类型页 / 标签 / 搜索」整组换掉：
   * 在「全部内容」勾了 9 条 → 切到剧集墙，工具栏仍显示「已选 9 项 / 加入剧集 / 移除」，
   * 但这 9 条在新视图里**一个都看不见**（用户原话：「全选本页 … 依然是全局过滤」）。
   * 打开剧集详情同理 —— 详情页展示的是分集，不是条目选择集。
   *
   * 修法：作用域一变就清空。用「重算身份」而不是手写 `useEffect` 监听 `view`——
   * 后者要额外枚举 tabs/标签/搜索，漏一处就漏一处；这里任一维度变化都会重算。
   * 在渲染期 setState 是 React 官方的「按 prop 变化调整 state」写法，会在本次渲染
   * 落地前重渲染，不会有「先画一帧旧选择态」的闪烁。
   */
  const selectScope = `${view}|${tab}|${activeTagId ?? ''}|${search.trim()}`
  const [selectionScope, setSelectionScope] = useState(selectScope)
  if (selectionScope !== selectScope) {
    setSelectionScope(selectScope)
    if (selected.size > 0) setSelected(new Set())
  }

  // ---------- 操作 ----------
  const onPosterReady = useCallback(
    (patch: { id: number; poster: string; duration?: number }) => {
      // 静默回写：失败不影响展示（内存里已有封面）
      void patchMediaItem(patch.id, {
        poster: patch.poster,
        duration: patch.duration,
      }).catch(() => undefined)
      // 抽帧结果已落库，但**缓存里那份仍是 `poster: null`**（BUG-138）。不失效的话，
      // 下次进 items 视图命中缓存 → 卡片按 `poster` 为空重新抽帧（视频逐条解码）
      // 并再次 PATCH，每次进出都重做一遍。失效后最多多一次列表请求，
      // 而封面已入库 ⇒ 那一次请求回来的数据自带 poster，不再重复生成。
      // （收敛性：封面入库后不再产生写操作，缓存从此稳定命中。）
      invalidateCache(cacheKey.mediaListPrefix())
      setItems((prev) =>
        prev.map((i) =>
          i.id === patch.id
            ? { ...i, poster: patch.poster, duration: patch.duration ?? i.duration }
            : i,
        ),
      )
    },
    [],
  )

  const refreshAll = async () => {
    // **先失效、再重取**：写操作之后必须作废读缓存，否则会看着「刚改完的标题又变
    // 回去了」（缓存里存的是改动前那一份，且它不会自己过期）。顺序不能反 ——
    // 原来的 `await loadMeta()` 在 `invalidateCache()` **之前**，stats/tags 一旦
    // 也走缓存，就会读到改动前那一份（BUG-239 失效纪律）。
    //
    // 不传 prefix = **全清**，故新增的条目列表键（`cacheKey.mediaList`，BUG-138）
    // 自动被覆盖 —— 这里的删除 / 导入 / 编辑 / 批量打标 / 加入剧集 / 合并都走它。
    // 上面那些按前缀精细失效的点，是**不经过 `refreshAll`** 的旁路（改标签、
    // 重缓存、移出分集、封面回写），它们各自负责清自己的键。
    invalidateCache()
    await loadMeta()
    if (view === 'items') await loadItems()
    else if (view === 'series') await loadSeries()
    else if (view === 'seriesDetail' && activeSeriesId) await openSeries(activeSeriesId)
  }

  /**
   * 删除指定条目 —— 单条与批量的**唯一执行路径**。
   *
   * 单条删除曾经不存在：只能「勾选一条 → 再去工具栏点移除」，选择态成了前置仪式。
   * 现在目标集由调用方给出（卡片传 `[id]`，工具栏传所选集合），执行链完全一致。
   *
   * **混合目标集分派**（M2-T00a）：cat-all 的选中集可能同时含媒体条目（正 id）
   * 与受管成品（负合成 id，行上带 `fileFact` 标记）——两者删除语义不同
   * （删媒体行 vs 删文件本体），执行前先拆集，再各自走自己的端点。
   */
  const doDeleteItems = async (ids: number[]) => {
    if (ids.length === 0) return
    const factPaths: string[] = []
    const mediaIds: number[] = []
    for (const id of ids) {
      const row = catAllRows.find((r) => r.id === id)
      const fact = (row as (MediaItem & { fileFact?: FileFact }) | undefined)?.fileFact
      if (fact) factPaths.push(fact.path)
      else mediaIds.push(id)
    }
    try {
      for (const p of factPaths) await deleteFile(p)
      for (const id of mediaIds) await deleteMediaItem(id)
      if (factPaths.length > 0) await loadDownloadFiles()
      clearSelection()
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 删除受管成品（文件本体）—— 单条入口（行内删除键）的执行路径。
   * daemon 侧守卫：路径必须落在受管根内（否则 403），必须是普通文件（否则 404）。
   */
  const doDeleteFiles = async (paths: string[]) => {
    if (paths.length === 0) return
    try {
      for (const p of paths) await deleteFile(p)
      clearSelection()
      await loadDownloadFiles()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 删除指定剧集 —— 单条与批量的**唯一执行路径**（BUG-214）。
   *
   * 与 `doDeleteItems` 同一模式：单条不再是「大小为 1 的另一种流程」，
   * 只是同一路径的一种目标集来源（这里是 `[id]`）。剧集域端点当前是**单数**的，
   * 故循环调用；批量端点若日后落地，只改这一处。
   */
  const doDeleteSeriesMany = async (ids: number[]) => {
    if (ids.length === 0) return
    try {
      for (const id of ids) await deleteSeries(id)
      // 选中的源已被删除，留着就是幽灵项（计数会多算）。
      clearSeriesSelection()
      setView('series')
      setDetail(null)
      setActiveSeriesId(null)
        appliedFmode.current = 'lib-series'
        onFmodeChange?.('lib-series')
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ---------- 渲染 ----------
  const clearFilters = useCallback(() => {
    setActiveTagId(null)
    setSearch('')
  }, [])

  // BUG-131：`activeTagId` 对 series 视图同样生效（`loadSeries` 消费它），故不加视图条件；
  // `search` 只在 items 视图真正参与过滤 ——
  // 否则 series 视图会呈现「已过滤」的假象（显示「清除筛选」却没有过滤发生）。
  const filterActive = activeTagId !== null || (view === 'items' && search.trim() !== '')

  /**
   * 路径 → 稳定负 id（FNV-1a 取正后取负）。
   *
   * 受管成品没有 `media_item` 行，但选择态 / testid / 批量目标集全按数字 id 走；
   * 负值与媒体条目的正 id **不可能相撞**，且同路径恒定（重渲染不换 id，
   * 选中态不会莫名丢失）。
   */
  const factId = (path: string): number => {
    let h = 0x811c9dc5
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return -(Math.abs(h) % 0x3fffffff) - 1
  }

  /**
   * cat-all 显示行 = 已登记媒体 ∪ 受管成品（M2-T00a/M2-T01a）。
   *
   * - **去重按绝对路径**（`absolutePath ?? filePath` 规范化后比较）：手动导入过
   *   的下载成品同时在两边的，只认媒体条目那一份（它有更完整的元数据）；
   * - 成品行带 `fileFact` 标记 —— 打开/删除据此分派（系统程序打开 / 删文件本体），
   *   见 `openItem` / `deleteItem` / `doDeleteItems`；
   * - `kindLabel` 直接给分类键（`category.Archives` 等），类型列不落到
   *   「doc/archive/other 三落 file」的有损映射（BUG-299 违反标记的兑现）。
   */
  const catAllRows = useMemo<(MediaItem & { fileFact?: FileFact; kindLabel?: string })[]>(() => {
    if (tab !== 'all') return items
    const norm = (p?: string | null) => (p ?? '').replace(/\\/g, '/').toLowerCase()
    const taken = new Set(items.map((i) => norm(i.absolutePath ?? i.filePath)).filter(Boolean))
    const facts = downloadFiles
      .filter((f) => !taken.has(norm(f.path)))
      .map((f): MediaItem & { fileFact: FileFact; kindLabel: string } => ({
        id: factId(f.path),
        source: 'download',
        ref: '',
        title: f.name,
        kind:
          f.kind === 'video' || f.kind === 'photo' || f.kind === 'audio' ? f.kind : 'file',
        filePath: f.path,
        absolutePath: f.path,
        // 0 字节也是事实：照常列出并带「缺字节」标记（BUG-132 同款诚实口径）。
        bytesPresence: f.size > 0 ? 'present' : 'missing',
        size: f.size,
        addedAt: f.modified_at,
        tags: [],
        kindLabel: `category.${f.category}`,
        fileFact: f,
      }))
    if (facts.length === 0) return items
    // 「最近添加」是默认排序：两源按日期真合并（下载成品 mtime vs 媒体 addedAt）；
    // 其余排序媒体侧走服务端，成品行附后（M2-T02 六分类归一后再统一）。
    if (sort === 'recent') {
      return [...items, ...facts].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
    }
    if (sort === 'oldest') {
      return [...items, ...facts].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
    }
    return [...items, ...facts]
  }, [tab, items, downloadFiles, sort])

  /**
   * 「全选本页」的目标集 = **当前真正可见的行**（BUG-155 语义的直接延伸：
   * 选中的必须是看得见、可被操作的行）。
   *
   * cat-all（Explorer 列表视图）显示的是 `catAllRows`（已登记媒体 ∪ 受管下载
   * 成品），**不是** `items` —— 若照旧取 `items.map(id)`，全选会漏掉全部受管
   * 成品行（合成负 id），用户在列表里看到「只选了一半」。分类子视图
   * （视频/图片/音频…）与 catAllRows 无关，仍取 `items`。
   *
   * 声明必须在 `catAllRows` **之后**（TDZ）：它读的是那个 memo。
   */
  const visibleIds = useMemo(
    () => (view === 'items' && tab === 'all' ? catAllRows : items).map((i) => i.id),
    [view, tab, catAllRows, items],
  )

  /**
   * 删除确认的目标集：卡片逐条 = `[id]`，工具栏批量 = 当前勾选。
   *
   * 用**显式集合**而不是「每次都读 selected」，同一套确认状态机才能服务两种入口
   * （单条删除不再是「大小为 1 的批量」，而是同一路径的另一种目标集来源）。
   */
  const confirmTargetIds =
    confirmDelete?.kind === 'items' ? (confirmDelete.ids ?? [...selected]) : []
  /**
   * 目标集里**已归入剧集**的条数。
   *
   * 删掉剧集的最后一集会让剧集变成空壳 —— 这是用户看不见的隐性状态，
   * 必须在按下确认**之前**报出来，而不是删完才发现少了个剧集。
   */
  const confirmGroupedCount = items.filter(
    (i) => confirmTargetIds.includes(i.id) && i.seriesTitle,
  ).length

  /**
   * 剧集删除确认的目标集（BUG-214）：`ids`（批量/工具栏）与 `id`（详情卡逐条）**同一路径**。
   */
  const confirmSeriesIds = useMemo(
    () =>
      confirmDelete?.kind === 'series'
        ? (confirmDelete.ids ?? (confirmDelete.id !== undefined ? [confirmDelete.id] : []))
        : [],
    [confirmDelete],
  )

  /**
   * 删除确认里要列出的剧集清单（BUG-214）：**必须列出将删剧名与集数**。
   *
   * 剧名从「墙上的列表 / 当前选中集 / 详情」三处按 id 查 —— 详情卡逐条删除时
   * 该剧集可能已被标签筛掉而不在 `series` 里，只认一个来源就会渲染出光秃秃的 `#id`。
   * 三处都没有（数据早被删掉的极端情况）时如实退成 `#id`，不编造标题。
   */
  const confirmSeriesRows = useMemo(() => {
    const byId = new Map<number, { id: number; title: string; episodeCount: number }>()
    const put = (s: MediaSeries) => {
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, title: s.title, episodeCount: s.episodeCount })
    }
    for (const s of series) put(s)
    for (const s of selectedSeriesList) put(s)
    if (detail) put(detail)
    return confirmSeriesIds.map((id) => byId.get(id) ?? { id, title: `#${id}`, episodeCount: 0 })
  }, [confirmSeriesIds, series, selectedSeriesList, detail])

  // 空态必须区分「库真的空」（引导导入/缓存）与「筛选无结果」（引导清筛选）——
  // 把后者渲染成"文件管理里还没有内容 + 导入目录"会误导用户以为数据丢了。
  // 判据用**库级统计** stats.items，不能用列表响应的 total：
  // total 是筛选后总数（标签筛空时为 0），会让"无匹配"伪装成"库空"。
  const libraryEmpty = (stats?.items ?? 0) === 0

  /**
   * 空态文案（M0-T03·tasks.md 第 2 条，BUG-298 实施记录⑩）：
   * 规划包原文 = 「下载/缓存完成的内容会自动出现在这里」（D16 语义前置）。
   * 落地时按「宁可没有、也不编造」收敛为当前事实：TG 缓存与导入今天确实自动出现，
   * **HTTP 下载完成自动入库尚未接线**（BUG-299 / M2-T01，ingest 只有 TG 一条路径）
   * ⇒ 文案明确写出这条正在完善 + 给出「打开目录」的现实出路，不替未落地的能力背书。
   * （缺陷号只进注释与缺陷档，用户可见文案不带内部编号。）
   */

  /**
   * 左栏标签区（BUG-259）：当前是否「剧集侧」—— 决定标签计数取 `itemCount` 还是
   * `seriesCount`。左栏 chip 与下方展开控件的计数必须同源，故提到组件体只算一次。
   */
  const railSeriesSide = view === 'series' || view === 'seriesDetail'
  /**
   * 非零标签总数（与 chip 渲染同一条 0 计数规则，BUG-068）。收起态只渲染前
   * `RAIL_TAG_LIMIT` 个，展开控件靠这个数给出「还有 N 个」—— 没有它用户无法
   * 知道发生过截断。**不含**「选中项例外」（那个例外只服务 chip 的取消入口）。
   */
  const railTagTotal = tags.filter((tag) =>
    railSeriesSide ? (tag.seriesCount ?? 0) > 0 : (tag.itemCount ?? 0) > 0,
  ).length

  /**
   * 占用空间的主口径与是否有两个口径（BUG-133）。
   *
   * `diskBytes` 缺失 = 后端还没提供磁盘真值，此时**回退登记值**并改口径说明，
   * 而不是显示 0 或假装它就是磁盘占用。
   */
  const hasDiskBasis = typeof stats?.diskBytes === 'number'
  const leadingBytes = hasDiskBasis ? (stats?.diskBytes ?? 0) : (stats?.totalSize ?? 0)
  /**
   * 占用空间的显示值。
   *
   * `fmtSize(0)` 返回 `—`（它的语义是「没有读数」）。但「磁盘占用真的归零了」
   * 是一个**确定的事实**，不是缺读数 —— 显示成 `—` 会让刚清完缓存的用户以为
   * 「读不出来 / 又坏了」，恰恰是 BUG-133 那类「数字不反映事实」的翻版。
   * 故归零时显式写 `0 B`，只有**真的没有读数**时才轮到 `—`。
   */
  const fmtOccupancy = (b: number): string => (b > 0 ? fmtSize(b) : '0 B')
  const emptyState = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10">
      {libraryEmpty ? (
        <>
          <p className="text-sm text-muted">{loading ? t('media.loading') : t('media.empty')}</p>
          {!loading && (
            <>
              <p className="max-w-sm text-center text-[11px] leading-relaxed text-muted">
                {t('media.emptyHint')}
              </p>
              <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setImportOpen(true)}>
                {t('media.importDir')}
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{t('media.noMatch')}</p>
          {filterActive && (
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={clearFilters}>
              {t('media.clearFilter')}
            </Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-surface/20">
      {/* ───────── 左栏导航 ───────── */}

      {/* ───────── 主区 ───────── */}
      {/* `relative` 是动作条（BUG-214）的定位锚：动作条 `absolute bottom-4` 相对**内容区**
          （不是视口），故不会被 .fixed 的祖先 transform/backdrop 影响定位。 */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 工具条 */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle/60 px-3 py-2">
          {/* 详情态：返回是**页面导航** ⇒ 属工具栏作用域（v3 W mock 头部行同位）。
              剧集实体的合并/导出/删除**不进工具栏** —— 它们落在 SeriesDetail
              总览卡（实体表面）。工具栏恒为库级语义，全视图一致。 */}
          {view === 'seriesDetail' && detail ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-[11px]"
              data-testid="series-back"
              onClick={() => {
                setView('series')
                setDetail(null)
                setActiveSeriesId(null)
                appliedFmode.current = 'lib-series'
                onFmodeChange?.('lib-series')
                void loadSeries()
              }}
            >
              ← {t('media.series.back')}
            </Button>
          ) : null}
          {/* BUG-131：搜索与排序只对 items 视图生效，故只在 items 视图渲染 ——
              恒渲染但恒无效，等于控件在撒谎（同排「仅未归集」早已是这种守卫写法）。 */}
          {view === 'items' ? (
            <div className="w-44 min-w-0">
              <Input
                data-testid="media-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('media.search')}
                className="h-7 text-xs"
              />
            </div>
          ) : null}
          {view === 'items' ? (
            <select
              data-testid="media-sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="h-7 rounded-md border border-border-subtle bg-surface px-2 text-[11px] text-fg-strong"
            >
              <option value="recent">{t('media.sortRecent')}</option>
              <option value="oldest">{t('media.sortOldest')}</option>
              <option value="title">{t('media.sortTitle')}</option>
              <option value="duration">{t('media.sortDuration')}</option>
              <option value="size">{t('media.sortSize')}</option>
            </select>
          ) : null}
          {/* BUG-304 / D18：原「只看散片（未归入剧集）」勾选框删除 —— 「未归档」状态本身
              取消（视频=剧集 ⇒ 单集即单集剧集），该筛选永远只会返回空集。
              后端 `?unassigned=` 参数保留（BUG-138 缓存键判据仍在用），只是前端不再有入口。 */}

          {/*
            M0-T03：占用空间读数从左栏底部**原样搬到工具条**（左栏已删）。
            BUG-149：重构不是删能力的授权 —— 用户能看到的读数不随导航重整静默消失。
            两个口径仍同时可查（BUG-133 判据 2，缺陷仍 open，此处只做位置迁移、
            不改口径语义）：主口径 = 磁盘真值（清缓存后下降）；登记值显式标注
            「不是本地磁盘占用」。`diskBytes` 缺失时主口径回退登记值并改说明，
            不显示 0、不假装它是磁盘占用。

            BUG-317 四件套③：这个读数是文件页的 **page-secondary-info**
            （标题区下方的计数摘要，恒定口径）。库级按钮已在任务 #9 上移到
            标题区右槽（ContextBar 的 files 分支），本工具条只余搜索/排序与本读数。
          */}
          {stats && (
            <span
              className="shrink-0 text-[11px] text-muted"
              data-testid="page-secondary-info"
              title={`${hasDiskBasis
                ? '占用空间 = 文件管理在本机实际占用的磁盘字节（清缓存后会下降）'
                : '占用空间 = 文件管理登记的内容大小（后端未提供磁盘占用读数；清缓存后此值不变）'}\n登记值 = 内容在源头的大小之和（未落盘/字节已清的内容仍计入），不是本地磁盘占用`}
            >
              占用 {fmtOccupancy(leadingBytes)}
              {stats.diskBytesTruncated ? '（已截断）' : ''} · 登记{' '}
              {typeof stats.totalSize === 'number' ? fmtSize(stats.totalSize) : '—'}
            </span>
          )}

        </header>
        {/*
         * M0-T03：标签云从左栏搬迁到内容区。
         * BUG-304 / D18：导航不再有「标签」树项（标签是**过滤维度**不是目的地），
         * 标签云与筛选框都留在剧集墙顶部；筛选框从「列表下方、仅展开态」改为
         * **列表上方、常态可见** —— 原位置自相矛盾（要筛就得先滚过全部标签，
         * 而滚完已经看见了全部）。BUG-259 的截断/展开两条规则保留，testid 不变。
         */}
        {view === "series" && (
          <>
                    <div className="flex items-center gap-2 px-2 pt-3">
                      {/* 标签筛选样式（2026-10-14 修正）：「标签」标签与筛选输入框**同一套式样**
                          —— 同字号（11px）、同字重（medium）、同前景色（text-fg-soft），
                          不再用「极小 uppercase muted 小标签 + 撑满大输入框」两套视觉。 */}
                      <span className="shrink-0 text-[11px] font-medium text-fg-soft">
                        {t('media.tags')}
                      </span>
                      {/* BUG-304 / D18：常态可见，不再等 `tagExpanded`；且必须在 chip 列表
                          **之前** —— 筛选框与它筛选的对象必须同屏。 */}
                      <Input
                        data-testid="media-tag-filter"
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        placeholder={t('media.tag.filterPlaceholder')}
                        className="h-7 flex-1 text-[11px]"
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 px-1" data-testid="media-tag-list">
                      {(() => {
                        /*
                         * 标签 chip 的两条规则（BUG-068）：
                         *
                         * 1) **0 计数不渲染**。删除条目/剧集只清关联表、不 GC `media_tag` 行，
                         *    于是每次删除都会留下一批 0/0 孤儿标签，越积越多 —— 界面上表现为
                         *    「底部一大片全是 0」。孤儿在数据层无害，但**渲染它们等于给出一排
                         *    点了必空的入口**，所以过滤放在渲染层。例外的只有当前选中项（同上）。
                         *
                         * 2) **当前侧的计数必须就是筛选结果的条数**。旧式 `itemCount + seriesCount`
                         *    在内容侧把剧集挂载也算进去，而内容侧筛选只匹配条目 —— 显示 8、点开
                         *    6 条。现在两侧各算各的（内容=itemCount，剧集=seriesCount），
                         *    「显示的数 = 点下去得到的数」。
                         */
                        const seriesSide = railSeriesSide
                        const withCount = tags
                          .map((tag) => ({
                            tag,
                            count: seriesSide ? (tag.seriesCount ?? 0) : (tag.itemCount ?? 0),
                          }))
                          /* BUG-259：按片数降序 —— 用户 2026-10-13 裁定「显示应该显示最多片的
                             标签」。同数按名称定序，避免刷新后顺序抖动。 */
                          .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
                        const visible = withCount.filter(
                          ({ tag, count }) => count > 0 || activeTagId === tag.id,
                        )
                        if (visible.length === 0) {
                          return <p className="px-1 text-[10px] text-muted">—</p>
                        }
                        const q = tagFilter.trim().toLowerCase()
                        const searched = q
                          ? visible.filter(({ tag }) => tag.name.toLowerCase().includes(q))
                          : visible
                        /* BUG-259：收起态**截断**（只渲染片数最多的前 RAIL_TAG_LIMIT 个），
                           不是「限高 + 滚动」—— 左栏不允许出现任何滚动容器。展开态渲染全部；
                           **过滤生效时也渲染全部匹配**（BUG-304 / D18：筛选框在列表上方，
                           用户输入后若只看到前 N 个匹配，会以为「就这些」）。选中的标签
                           **永远渲染**，否则用户看不到自己在筛什么、也没有可点的取消入口
                           （同 BUG-068 的例外规则）。 */
                        const shown = tagExpanded || q
                          ? searched
                          : searched
                              .slice(0, RAIL_TAG_LIMIT)
                              .concat(
                                searched.slice(RAIL_TAG_LIMIT).filter(({ tag }) => tag.id === activeTagId),
                              )
                        return shown.map(({ tag, count }) => {
                          const on = activeTagId === tag.id
                          const title = `${t('media.items')} ${tag.itemCount ?? 0} · ${t('media.series')} ${tag.seriesCount ?? 0}`
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              title={title}
                              data-testid={`media-tag-chip-${tag.id}`}
                              onClick={() => {
                                setActiveTagId(on ? null : tag.id)
                                // BUG-304 / D18：标签云只在 `view === 'series'` 渲染（树里已无
                                // 「标签」项），故原「内容侧点标签 → 切 items 网格」的分支**不可达**，
                                // 与 `switchTab` 一并移除。留下的行为与原 else 分支逐字相同。
                                  setDetail(null)
                                  clearSelection()
                              }}
                              className={[
                                // 单行原语：`whitespace-nowrap` 禁折行、名称 `truncate`（需 min-w-0）
                                // 允许截断、计数 `shrink-0` 永不先被压掉、`max-w-full` 封顶不撑破容器。
                                // 形状 `rounded` 且**不带边框/底色**：标签不再有颜色语义，选中靠
                                // 实心强调底表达（与 TagToken 的 `active` 同一套视觉）。
                                'inline-flex max-w-full items-baseline gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] transition-colors',
                                on
                                  ? 'bg-accent text-white'
                                  : 'text-muted hover:bg-surface-2 hover:text-fg-strong',
                              ].join(' ')}
                            >
                              <span className={on ? 'text-white/70' : 'text-accent/80'}>#</span>
                              <span className="min-w-0 truncate">{tag.name}</span>
                              <span className="shrink-0 tabular-nums opacity-70">{count}</span>
                            </button>
                          )
                        })
                      })()}
                    </div>
                    {/* BUG-259：收起态是**截断**（不是限高 + 滚动），所以必须给出「还有 N 个」
                        的可点出口 —— 否则被截掉的标签在界面上无从发现。
                        BUG-304 / D18：过滤框已移到**列表上方**（常态可见），这里只剩展开/收起。 */}
                    {railTagTotal > RAIL_TAG_LIMIT || tagExpanded ? (
                      <div className="mt-1 flex items-center gap-1 px-1">
                        <button
                          type="button"
                          data-testid="media-tag-toggle"
                          aria-expanded={tagExpanded}
                          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-accent transition-colors hover:bg-accent/10"
                          onClick={() => {
                            setTagExpanded((v) => !v)
                            setTagFilter('')
                          }}
                        >
                          {tagExpanded
                            ? t('media.tag.collapse')
                            : t('media.tag.showAll', { n: Math.max(0, railTagTotal - RAIL_TAG_LIMIT) })}
                        </button>
                      </div>
                    ) : null}
          </>
        )}

        {/*
          来源后端不可用的**非阻断**提示（S3）：
          TG 没起只意味着「暂时不能原路取回字节」，库本身照常可浏览可管理。
          这里写死成整页占位是错的——那是把「一个来源不可用」渲染成「库不可用」。
        */}
        {alive && hasDownSource ? (
          <div
            className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 bg-surface-2/50 px-3 py-1.5 text-[11px] text-muted"
            data-testid="media-source-offline-banner"
          >
            <span className="min-w-0 flex-1 truncate">
              {t('media.sourceOfflineHint', { sources: downSourceLabels })}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void reconnectSources()}
            >
              {t('media.reconnectSource')}
            </Button>
          </div>
        ) : null}

        {/* 内容区 */}
        {!alive ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10">
            <p className="text-sm text-muted">{t('media.offline')}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs"
              disabled={libRetrying}
              onClick={() => void probeLibrary()}
            >
              {libRetrying ? t('media.connecting') : t('media.retryConnect')}
            </Button>
          </div>
        ) : view === 'seriesDetail' && detail ? (
          <SeriesDetail
            detail={detail}
            tags={tags}
            onPlay={playEpisode}
            onRemoveEpisode={async (ep) => {
              try {
                await deleteEpisode(ep.id)
                // 移除分集改变了剧集详情与剧集列表的集数 —— 必须先失效再重取。
                // 否则 `openSeries` / `loadMeta` 会命中改动前那一份（缓存不过期），
                // 被移除的分集仍然显示 —— 正是「删了还在」（BUG-239 失效纪律）。
                if (activeSeriesId) invalidateCache(cacheKey.seriesDetail(activeSeriesId))
                invalidateCache(cacheKey.seriesList(activeTagId))
                invalidateCache(cacheKey.seriesList(null))
                // 条目列表同样要清（BUG-138）：移出分集改变了该条目在列表里的
                // `seriesId` / `seriesTitle`（后端 ITEM_SELECT 按 episode 关联取），
                // 以及「仅未归集」筛选下的命中集合 —— 不清则卡片上的剧集归属与
                // 「未归集」计数停在移除前那一份。
                invalidateCache(cacheKey.mediaListPrefix())
                if (activeSeriesId) await openSeries(activeSeriesId)
                await loadMeta()
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            }}
            onDeleteSeries={() => setConfirmDelete({ kind: 'series', id: detail.id })}
            onMerge={() => setMergeOpen(true)}
            onBack={() => {
              setView('series')
              setDetail(null)
        appliedFmode.current = 'lib-series'
        onFmodeChange?.('lib-series')
              setActiveSeriesId(null)
              void loadSeries()
            }}
            onChanged={() => void refreshAll()}
            onError={(m) => setError(m)}
            onCreateTag={async (name) => {
              try {
                const r = await createTag(name)
                await refreshTags()
                return r.id
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
                return null
              }
            }}
            onExport={() => setExportOpen(true)}
            onViewInTg={viewInTg}
            onGotoItem={(itemId) => {
              // BUG-191：按钮文案是「在媒体库中查看该内容」（`media.episode.gotoItem`），
              // 行为就必须是**查看** —— 原实现 `setEditing(...)` 打开的是 `ItemEditDialog`
              // 编辑面板，文案与行为两条真源分叉，用户点「查看」得到的是编辑界面。
              //
              // 编辑能力不因此丢失：分集另有 `episode-edit` / `episode-slot` 编辑入口
              // （见 BUG-171 索引行），「查看」与「编辑」不再挤在同一个按钮上。
              //
              // 这里不做「切视图 + 滚动定位到卡片」：条目可能不在当前筛选页里，强行滚动
              // 会落在错误的位置；直接打开查看器才是「查看该内容」的准确实现。
              void (async () => {
                try {
                  const item = await getMediaItem(itemId)
                  openViewer({ items: [toViewerItem(item)], index: 0, title: item.title })
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              })()
            }}
          />
        ) : view === 'series' ? (
          <div
            data-testid="series-wall-scroll"
            className="min-h-0 flex-1 overflow-y-auto p-3"
          >
            {/*
             * 剧集墙动作条**已移出这里**（BUG-214）：它原先挂在滚动容器内的普通流顶部，
             * 勾选视口外/下方的卡片后向上浏览时就随内容滚出视野，动作不可达。
             * 现在浮在内容区底部（见下方 `series-selection-bar`）。
             */}
            {series.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20">
                {filterActive ? (
                  <>
                    <p className="text-sm text-muted">{t('media.noMatch')}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={clearFilters}
                    >
                      {t('media.clearFilter')}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted">{t('media.noSeries')}</p>
                    <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setCreateOpen(true)}>
                      ＋ {t('media.newSeries')}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                {series.map((s) => (
                  <SeriesCard
                    key={s.id}
                    series={s}
                    tags={tags}
                    selected={selectedSeries.has(s.id)}
                    onSelectToggle={toggleSeriesSelect}
                    onOpen={() => void openSeries(s.id)}
                    onDelete={() => setConfirmDelete({ kind: 'series', id: s.id })}
                    onCoverReady={(id, poster) => {
                      void patchSeries(id, { poster }).catch(() => undefined)
                      setSeries((prev) =>
                        prev.map((x) => (x.id === id ? { ...x, poster } : x)),
                      )
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : view === 'items' && tab === 'all' && catAllRows.length > 0 ? (
          /*
           * 「全部文件」= 文件域父行（cat-all）→ **Explorer 列表**（BUG-299 出口判据）。
           *
           * 2026-10-15 用户裁定：「文件管理是列表，是 Explorer 显示，但绝对不可
           * 能是视频」。据此，文件域的默认呈现从「媒体海报墙」改为「行列表」：
           * 名称/类型/大小/日期/来源 + 行内动作，单击选中、双击打开。
           *
           * 判据取 `tab === 'all'` 而不是 `view === 'items'`：分类子行（视频/图片/
           * 音频）仍是各自类型的浏览墙（MediaCard），只有「全部」这个**域级**父行
           * 用列表。
           *
           * 行集 = `catAllRows`（已登记媒体 ∪ 受管下载成品，M2-T00a）——判据 7
           * 的「共通性」就在这一行：zip/exe/pdf 与媒体同列表、同动作。
           */
          <FileListView
            items={catAllRows}
            selected={selected}
            total={total + Math.max(0, catAllRows.length - items.length)}
            onSelectToggle={toggleSelect}
            onOpen={openItem}
            onDelete={deleteItem}
            onError={setError}
            // 选择模式（任务 #9）：已有 ≥1 条选中时，行双击与「打开」按钮
            // 不进入播放/系统打开（覆盖层会冲掉隐形的选择上下文）。
            selectionMode={selected.size > 0}
            // BUG-385：行级「在 TG 中查看」—— 文件域筛选落地视图的跳转出口
            // （与 SeriesDetail 来源块入口同一个 `viewInTg` 回调、同一套坐标门控）。
            onViewInTg={viewInTg}
          />
        ) : items.length === 0 && !loading ? (
          emptyState
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div
                data-testid="media-grid"
                className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
              >
                {items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onSelectToggle={toggleSelect}
                    onOpen={openItem}
                    // 选择模式（任务 #9）：已有 ≥1 条选中时封面点击改切换选中，
                    // 禁入播放详情（用户裁定「不应该能点击进入播放详情页面」）。
                    selectionMode={selected.size > 0}
                    onEdit={setEditing}
                    // 逐条删除：目标集显式给 `[id]`，与工具栏批量走同一条确认路径
                    onDelete={deleteItem}
                    onPosterReady={onPosterReady}
                    // 无字节且来源支持原路取回时给「重新缓存」（BUG-080）
                    onRecache={recacheItem}
                    recacheBlockedReason={recacheBlockedReason(item.source, item.ref)}
                    // 视频=通用类（BUG-307 设计锁 2026-10-14）：items 网格不烤入 TG 跳转，
                    // TG 跳转只保留在剧集链路（SeriesDetail / 剧集墙派生），通用视频类将来
                    // 还会有十几个同类型插件，不能把 TG 当成视频的固有能力。
                  />
                ))}
              </div>
              {total > items.length ? (
                <p className="py-3 text-center text-[11px] text-muted">
                  {t('media.showing', { n: items.length, total })}
                </p>
              ) : null}
            </div>
          </>
        )}

        {/*
         * 剧集墙批量动作条（BUG-214 / BUG-393 统一化）：选中 **≥1** 条即出现，浮在内容区
         * **底部居中** —— 与下载域、items 视图共用同一套 `SelectionBar` 标准组件
         * （`docs/standards/style.md` §选择条）。`fixed` 视口相对 ⇒ 三处落点一致
         * （BUG-393 S1b 实测：absolute 会因包含块不同产生 96px 偏移，旧实现正是
         * `absolute`，所以此前与下载域/items 看着不一样）。
         * 剧集专属动作（合并/打标/导出/删除/清空）仍经 children 传入组件。
         */}
        {view === 'series' && seriesBulkReady ? (
          <SelectionBar
            count={selectedSeriesList.length}
            testId="series-selection-bar"
            countTestId="series-selection-count"
          >
            {/* BUG-393：全选/全不选并入标准组件（与下载域、items 同形）。 */}
            <SelectAllButtons
              onSelectAll={() => setSelectedSeries(new Set(series.map((s) => s.id)))}
              onSelectNone={clearSeriesSelection}
              allLabel={t('media.selectAll')}
              noneLabel={t('media.selectNone')}
              allTestId="series-select-all"
              noneTestId="series-select-none"
            />
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="series-merge-wall"
              disabled={!seriesMultiReady}
              title={seriesMultiReady ? undefined : t('media.series.bulkMergeDisabled')}
              onClick={() => setMergeMultiOpen(true)}
            >
              {t('media.seriesMergeOpen')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="series-bulk-tag"
              onClick={() => setBulkSeriesTagOpen(true)}
            >
              {t('media.series.bulkTag')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="series-bulk-export"
              onClick={() => {
                // 只预勾选选中集，**不**把 `series` 换成子集（见 `exportPreselect` 注释）。
                setExportPreselect(selectedSeriesList.map((s) => s.id))
                setExportOpen(true)
              }}
            >
              {t('media.series.bulkExport')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive"
              data-testid="series-bulk-remove"
              onClick={() =>
                setConfirmDelete({ kind: 'series', ids: selectedSeriesList.map((s) => s.id) })
              }
            >
              {t('media.series.bulkRemove')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="series-selection-clear"
              onClick={clearSeriesSelection}
            >
              {t('media.seriesSelectionClear')}
            </Button>
          </SelectionBar>
        ) : null}

        {/*
         * items 批量动作条（任务 #9 / BUG-317 统一化）：与剧集墙 `series-selection-bar`
         * 同构的**浮动底部条**，选中 ≥1 条即出现。
         *
         * 为什么从头部工具栏搬到这里（用户 2026-10-16 裁定「其余和剧集一样，
         * 使用弹出选择模式」）：
         *   - 选择态是**批量整理的心智**，动作发生在「选完之后」，视线焦点在网格里
         *     —— 顶部 sticky 常驻占一行、挤压内容高度，且选中前后头部整簇换血
         *     （原来两个分支互斥渲染），按钮位置每次跳变；
         *   - 全选/全不选放进选择条后，「进入选择模式」有了闭环入口：先勾任意一条
         *     → 条出现 → 全选本页 / 全不选 / 批量动作 / 清除一应俱全；
         *   - 形态与剧集墙完全一致（同一定位、同一样式、同一 testid 命名），
         *     用户在两处学到的是同一套交互。
         *
         * 库级动作（导入目录/新建剧集/导出/标签管理）**不在这里** —— 它们已上移到
         * 标题区右槽（BUG-317 四件套①②），任何视图恒定可用。
         */}
        {view === 'items' && selected.size > 0 ? (
          /* BUG-393：容器与计数改用**全仓标准** `SelectionBar`（样式标准唯一真源）。 */
          <SelectionBar
            count={selected.size}
            testId="items-selection-bar"
            countTestId="items-selection-count"
          >
            {/* 全选本页（BUG-155 语义保留）：填的是当前**可见** items 的 id。
                testid 沿用 `media-select-all`（验收脚本的既有契约）。 */}
            {/* BUG-393：全选/全不选同样并入标准组件（成对出现，形态全仓一致）。 */}
            <SelectAllButtons
              onSelectAll={() => setSelected(new Set(visibleIds))}
              onSelectNone={clearSelection}
              allLabel={t('media.selectAll')}
              noneLabel={t('media.selectNone')}
              allTestId="media-select-all"
              noneTestId="media-select-none"
            />
            {/* 剧集收 video / photo（图片入浏览位）。含 audio/未知类型时禁用（后端 422 兜底） */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="items-add-to-series"
              disabled={!selectedJoinable}
              title={selectedJoinable ? undefined : t('media.addToSeriesVideoOnly')}
              onClick={() => setAddToOpen(true)}
            >
              {t('media.addToSeries')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="items-bulk-tag"
              onClick={() => setBulkTagOpen(true)}
            >
              {t('media.bulkTag')}
            </Button>
            {/* 批量整理（D24-A / BUG-311）：把选中条目按模板铺成可读名的硬链接/副本。 */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="media-organize"
              onClick={() => setOrganizeOpen(true)}
            >
              {t('media.organize.open')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive"
              data-testid="items-bulk-remove"
              onClick={() => setConfirmDelete({ kind: 'items' })}
            >
              {t('media.remove')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              data-testid="items-selection-clear"
              onClick={clearSelection}
            >
              {t('media.clearSel')}
            </Button>
          </SelectionBar>
        ) : null}
      </div>

      {/* ───────── 弹窗 ───────── */}
      {importOpen ? (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async (n) => {
            clearSelection()
            await refreshAll()
            setError(`已导入 ${n} 项`)
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {tagMgrOpen ? (
        <TagManagerDialog
          tags={tags}
          onClose={() => setTagMgrOpen(false)}
          onChanged={() => void refreshTags()}
          onError={(m) => setError(m)}
        />
      ) : null}

      {bulkTagOpen ? (
        <BulkTagDialog
          count={selected.size}
          tags={tags}
          onClose={() => setBulkTagOpen(false)}
          onCreate={async (name) => {
            try {
              const r = await createTag(name)
              await refreshTags()
              return r.id
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
              return null
            }
          }}
          onApply={async (tagIds) => {
            for (const id of selected) await setItemTags(id, tagIds)
            clearSelection()
            await refreshAll()
          }}
        />
      ) : null}

      {bulkSeriesTagOpen ? (
        // 剧集批量打标（BUG-214 P1）：与 items 侧同一组件，仅 `scope="series"` 换文案口径。
        <BulkTagDialog
          count={selectedSeriesList.length}
          tags={tags}
          scope="series"
          onClose={() => setBulkSeriesTagOpen(false)}
          onCreate={async (name) => {
            try {
              const r = await createTag(name)
              await refreshTags()
              return r.id
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
              return null
            }
          }}
          onApply={async (tagIds) => {
            for (const s of selectedSeriesList) await setSeriesTags(s.id, tagIds)
            clearSeriesSelection()
            await refreshAll()
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateSeriesDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            await refreshAll()
            void openSeries(id)
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {addToOpen ? (
        <AddToSeriesDialog
          itemIds={[...selected]}
          series={series}
          onClose={() => setAddToOpen(false)}
          onDone={async () => {
            clearSelection()
            await refreshAll()
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {organizeOpen ? (
        <OrganizeWizard
          itemIds={[...selected]}
          onClose={() => setOrganizeOpen(false)}
          onError={(m) => setError(m)}
        />
      ) : null}

      {exportOpen ? (
        <ExportPreviewDialog
          // `series` 恒为**全库候选**：预勾选只影响 `checked` 初值，
          // 绝不把候选换成选中子集（否则「子集全选」会被误判成全库导出）。
          series={series}
          preselect={exportPreselect ?? undefined}
          onClose={() => {
            setExportOpen(false)
            setExportPreselect(null)
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {mergeOpen && detail ? (
        <MergeSeriesDialog
          target={{ id: detail.id, title: detail.title, episodeCount: detail.episodeCount }}
          series={series}
          onClose={() => setMergeOpen(false)}
          onDone={async (res, sourceTitle) => {
            await refreshAll()
            if (activeSeriesId) await openSeries(activeSeriesId)
            // 跳过明细必须说出来：合并里唯一「少搬了东西」的地方，
            // 静默会让用户以为全搬完了（与「已导入 N 项」同一反馈位）。
            setError(
              res.skippedCount > 0
                ? `已把${seriesLabel(sourceTitle)}的 ${res.added} 集并入，${res.skippedCount} 集因已在剧中而跳过`
                : `已把${seriesLabel(sourceTitle)}的 ${res.added} 集并入`,
            )
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {mergeMultiOpen && seriesMultiReady ? (
        <MergeSeriesMultiDialog
          open={mergeMultiOpen}
          series={selectedSeriesList}
          onClose={() => setMergeMultiOpen(false)}
          onDone={async (res, targetTitle) => {
            // 合并成功：清空剧集选择（选中的源已被删除，留着就是幽灵项）。
            clearSeriesSelection()
            await refreshAll()
            setError(
              res.skippedCount > 0
                ? t('media.seriesMergeMultiDoneSkip', {
                    target: seriesLabel(targetTitle),
                    n: res.added,
                    m: res.skippedCount,
                  })
                : t('media.seriesMergeMultiDone', { target: seriesLabel(targetTitle), n: res.added }),
            )
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {editing ? (
        <ItemEditDialog
          item={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => void refreshAll()}
          onError={(m) => setError(m)}
          onCreateTag={async (name) => {
            try {
              const r = await createTag(name)
              await refreshTags()
              return r.id
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
              return null
            }
          }}
        />
      ) : null}

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-[13px] font-semibold text-fg-strong">
              {confirmDelete.kind === 'items'
                ? confirmTargetIds.length === 1
                  ? t('media.confirmRemoveOne')
                  : t('media.confirmRemoveItems')
                : confirmDelete.kind === 'files'
                  ? confirmDelete.paths.length === 1
                    ? t('media.confirmDeleteFile')
                    : t('media.confirmDeleteFiles', { n: confirmDelete.paths.length })
                  : confirmSeriesIds.length >= 2
                    ? t('media.seriesConfirmBulkTitle', { n: confirmSeriesIds.length })
                    : t('media.confirmDeleteSeries')}
            </h4>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              {confirmDelete.kind === 'items'
                ? t('media.confirmRemoveItemsHint', { n: confirmTargetIds.length })
                : confirmDelete.kind === 'files'
                  ? confirmDelete.paths.length === 1
                    ? t('media.confirmDeleteFileHint', { path: confirmDelete.paths[0] })
                    : t('media.confirmDeleteFilesHint', { n: confirmDelete.paths.length })
                  : confirmSeriesIds.length >= 2
                    ? t('media.seriesConfirmBulkHint')
                    : t('media.confirmDeleteSeriesHint')}
            </p>
            {/* 批量删剧集必须**列出将删剧名与集数**：确认框只说「删 3 个剧集」时，
                用户无从核对删的是哪三个（BUG-214 修复方向：两步确认 + 明示影响面）。 */}
            {confirmDelete.kind === 'series' ? (
              <>
                <div
                  data-testid="series-confirm-delete-list"
                  className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border-subtle bg-surface-2/40 p-1.5"
                >
                  {confirmSeriesRows.map((s) => (
                    <div
                      key={s.id}
                      data-testid="series-confirm-delete-item"
                      className="truncate px-1.5 py-0.5 text-[11px] text-fg-strong"
                    >
                      {seriesLabel(s.title)} · {t('media.episodeCount', { n: s.episodeCount })}
                    </div>
                  ))}
                </div>
                {/* 口径要点：删剧集 ≠ 删内容。这条**两态都渲染** —— 单条删除同样容易被
                    误以为「把内容也删了」，而事实是条目与已下载文件都保留
                    （AGENTS.md §5「删除联动（单向）」）。 */}
                <p
                  data-testid="series-confirm-keep-items"
                  className="mt-1.5 text-[11.5px] leading-relaxed text-emerald-600 dark:text-emerald-400"
                >
                  {t('media.seriesConfirmKeepItemsHint')}
                </p>
              </>
            ) : null}
            {/* 归属告知：删到最后一条会让剧集变空，这是用户看不见的隐性状态 */}
            {confirmDelete.kind === 'items' && confirmGroupedCount > 0 ? (
              <p
                className="mt-1.5 text-[11.5px] leading-relaxed text-amber-500"
                data-testid="confirm-grouped-warn"
              >
                {t('media.confirmGroupedWarn', { m: confirmGroupedCount })}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setConfirmDelete(null)}
                data-testid="media-confirm-no"
              >
                {t('tg.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={async () => {
                  const k = confirmDelete
                  setConfirmDelete(null)
                  // 单条与批量走**同一条**执行路径（BUG-214）：
                  // 目标集只是「从哪来的」不同，执行链不该有两份。
                  if (k.kind === 'items') await doDeleteItems(k.ids ?? [...selected])
                  else if (k.kind === 'files') await doDeleteFiles(k.paths)
                  else await doDeleteSeriesMany(k.ids ?? (k.id !== undefined ? [k.id] : []))
                }}
                data-testid="media-confirm-yes"
              >
                {t('media.confirm')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
