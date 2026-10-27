import { memo, useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CloudOff,
  FileText,
  Maximize2,
  Music,
  Pencil,
  Play,
  Send,
  Trash2,
  ZoomIn,
} from 'lucide-react'
import type { MediaItem } from '../../api/media'
import { kindLabelKey, mediaItemUrl, mediaThumbUrl } from '../../api/media'
import { useTranslation } from '../../i18n'
import { resolveDisplayName } from '../../lib/displayName'
import {
  coverFit,
  fmtDuration,
  fmtSize,
  hasMediaBytes,
  parseSourceRef,
  sourceLabelKey,
} from '../../lib/mediaSources'
import {
  cancelCoverJob,
  COVER_VIEWPORT_MARGIN,
  isPosterBudgetDropped,
  markPosterFailed,
  posterFailed,
  requestImageThumb,
  requestVideoPoster,
} from '../../lib/poster'
import { TagToken } from './TagToken'

const KIND_ICON: Record<string, string> = {
  video: '🎬',
  photo: '🖼',
  audio: '🎵',
  file: '📄',
}

/**
 * 悬浮操作层图标 —— **按条目类型分流**（BUG-123）。
 *
 * 缺陷现场：用户点开一张图片，进到的却是视频播放器。根因不是分流缺失
 * （`MediaViewer.modeOf` 早就按 `kind` 分好了），而是**点击之前无从分辨**：
 * 网格里视频与图片都只有一张缩略图，且 hover 层统一挂着一个播放三角 ——
 * 图片卡片 hover 也显示 ▶，用户自然以为点下去是播放。
 *
 * 所以图标只表达「点开会进入哪种视图」，不表达「能不能播」：
 *   - video → `Play`（播放语义，保持原状）
 *   - photo → `ZoomIn`（**看图语义**；绝不能用播放三角，那正是本缺陷的误导源）
 *   - audio → `Music`（音符，点开是播放器但载体是音频，与视频的视觉区分）
 *   - file / 未知 → `Maximize2`（中性的「打开」，不承诺任何媒体行为）
 *
 * 硬约束：**任何「只用一张缩略图代表条目」的设计都会复现本条缺陷。**
 * 换皮、换布局时这条不能丢 —— 卡片必须在点击前就给出类型信号
 * （hover 图标 + 常驻类型徽标，两者互补：前者要悬停，后者不用）。
 */
const KIND_ACTION_ICON: Record<string, LucideIcon> = {
  video: Play,
  photo: ZoomIn,
  audio: Music,
  file: FileText,
}
/** 未知类型不给任何媒体语义，退回中性的「打开」 */
const FALLBACK_ACTION_ICON: LucideIcon = Maximize2

/**
 * 类型徽标文案（BUG-123 引入，BUG-128 改为 i18n 键，BUG-258 上收到 `api/media`）。
 *
 * 映射本身已搬到 `api/media.ts#kindLabelKey`，与 `ItemEditDialog` 的只读类型行
 * 共用同一份 —— 两处各写一遍时，其中一处迟早漏掉新类型（BUG-258 的内容弹窗就是
 * 漏了：不走 i18n，直接渲染后端原始枚举）。
 *
 * 视觉刻意压低（10px、半透明黑底）—— 它是辅助信号，不抢标题与封面的戏。
 * 未知类型**不画徽标**（`kindLabelKey` 返回 null）：显示一个错的类型比不显示更糟。
 */

/**
 * 海报卡片（主流媒体站样式）：16:9 封面 + 悬浮操作层 + 标题/元信息。
 *
 * 封面策略（三级）：
 *   1. 后端已存 `poster`（data-uri）——直接用
 *   2. 图片类直接取原图（浏览器自适应缩放，无需额外生成）
 *   3. 视频类首次进入视口时抽帧生成，成功后回写后端，后续永久复用
 *
 * `memo` 化（BUG-026 流畅优先）：一屏最多 120 张卡，父面板任何一次 setState
 * 都会带着整墙重渲染 —— 封面抽帧是解码级开销，重渲染一次就重算一次。
 */
function MediaCardBase(props: {
  item: MediaItem
  selected?: boolean
  /** 剧集里的集号标签，如 `S1E3` */
  episodeLabel?: string
  onSelectToggle?: (id: number, shiftKey: boolean) => void
  onOpen: (item: MediaItem) => void
  /**
   * **选择模式**（任务 #9 / BUG-317 选择模式裁定）：
   * 面板里**已有 ≥1 条被选中**时为 true。此时封面点击改走**切换选中**，
   * 不再打开播放详情 —— 用户一旦进入「批量整理」的心智，误点封面把
   * 播放器弹到全屏会连选择态带上下文一起丢失（选择集是隐形的：
   * 播放器是覆盖层，回来后用户看不到任何「刚才选了哪些」的残留）。
   * Ctrl/Cmd 点击在两种模式下都是切换选中（既有行为，不变）。
   */
  selectionMode?: boolean
  onEdit?: (item: MediaItem) => void
  /**
   * 逐条删除入口（BUG-057）。
   *
   * 此前删除只作为**批量动作**存在（工具栏里，且挂在 `selected.size > 0` 之下），
   * 单条删除只能退化成「大小为 1 的批量」：先勾选、再找工具栏、再确认。
   * 选择态被当成删除的前置仪式 —— 这里是把它拿掉，删除与编辑同级。
   */
  onDelete?: (item: MediaItem) => void
  /** 封面生成并回写成功后回调（用于就地更新列表，避免整页刷新） */
  onPosterReady?: (patch: { id: number; poster: string; duration?: number }) => void
  /**
   * 重新缓存入口（BUG-080）：来源支持原路取回的条目在字节被清掉后可取回。
   * 不支持的来源拿到 `null`，展示层只标「文件已丢失」。
   */
  onRecache?: (item: MediaItem) => void
  /**
   * 重新缓存**当前不可用**的原因（S3：来源后端没起，如 TG 未登录/未启动）。
   * 有值时按钮置灰并在 title 给出原因 —— 宁可给一个说清楚的死按钮，
   * 也不给一个点了必然报错的活按钮。
   */
  recacheBlockedReason?: string | null
  /**
   * 「在 TG 中查看」（BUG-305）：应用内跳到 TG 插件面板并定位这条内容的来源消息。
   *
   * 只有**来源自身能解释定位符**（`source='tg'` 且 `ref` 可解析出 `chat:msg`）时
   * 才渲染入口 —— 本地来源没有 TG 消息可跳，给了也是死按钮（判据：无坐标 ⇒ 无入口）。
   * 坐标由卡片自行解析后回传（与 `SeriesDetail` 的入口同一签名）；
   * 由 `MediaLibraryPanel` 接线：设 store 正向焦点 + `navigate('tg')`。
   */
  onViewInTg?: (coords: { chatId: number; messageId: number }) => void
}) {
  const {
    item,
    selected,
    episodeLabel,
    onSelectToggle,
    onOpen,
    onEdit,
    onDelete,
    onPosterReady,
    onRecache,
    recacheBlockedReason = null,
    onViewInTg,
    selectionMode = false,
  } = props
  const [poster, setPoster] = useState<string | null>(item.poster ?? null)
  const [genFailed, setGenFailed] = useState(false)
  /** 服务端缩略图不可用（未落盘 / HEIC 等解不动）⇒ 回落原图，只回落一次。 */
  const [thumbUnavailable, setThumbUnavailable] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  /**
   * 有没有字节（BUG-080）。
   *
   * 清缓存只删字节、留条目 —— 没有这个判断，清完缓存的卡片与正常内容**长得一样**，
   * 点下去 raw 端点 404、静默播不了。有没有字节是事实态，展示层必须如实呈现。
   *
   * BUG-250：这个判据必须在**封面生成之前**就成立。封面生成（video 抽帧 /
   * photo 缩略图）会向 `/api/media/items/:id/raw` 发请求，而该端点对无字节条目
   * 必然失败（video 实测 404）。此前 `playable` 只在渲染期（`{playable ? … : 占位}`）
   * 生效，两个 effect 漏判 ⇒「无字节不发请求」的意图在渲染之前就被打破，
   * 打开媒体库主页即刷 404。
   */
  const playable = hasMediaBytes(item)

  // 换条目时重置本地封面状态
  useEffect(() => {
    setPoster(item.poster ?? null)
    setGenFailed(posterFailed(`v-${item.id}`))
  }, [item.id, item.poster])

  /**
   * 视频封面：进入视口（含 `COVER_VIEWPORT_MARGIN` 余量）才抽帧（BUG-239 预算门 1）。
   *
   * 离开视口即撤销**尚未启动**的排队（门 1 后半）；去重、队列上限、播放让路都在
   * `lib/poster` 的预算层（`requestVideoPoster`）。因预算被丢弃的（队列满 / 离开视口
   * 撤销）**不是失败**：不进 `genFailed`，重新进入视口再试 —— 保证「省请求」
   * 不以「封面永久空白」为代价（BUG-239 覆盖不倒退）。
   */
  useEffect(() => {
    if (poster || genFailed) return
    if (item.kind !== 'video') return
    // BUG-250：无字节条目不发抽帧请求（/raw 对 video+missing 实测 404）
    if (!playable) return
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const key = `v-${item.id}`
    let alive = true
    let visible = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const attempt = () => {
      if (!alive || !visible) return
      requestVideoPoster(key, mediaItemUrl(item.id), 1, 480).then(
        (probe) => {
          if (!alive) return
          setPoster(probe.dataUrl)
          onPosterReady?.({
            id: item.id,
            poster: probe.dataUrl,
            duration: probe.duration || undefined,
          })
        },
        (e) => {
          if (!alive) return
          if (isPosterBudgetDropped(e)) {
            // 预算丢弃（队列满 / 离开视口撤销）：不是失败，稍后重试。
            if (visible) retryTimer = setTimeout(attempt, 1500)
            return
          }
          markPosterFailed(key)
          setGenFailed(true)
        },
      )
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            visible = true
            attempt()
          } else {
            visible = false
            cancelCoverJob(key)
          }
        }
      },
      { rootMargin: COVER_VIEWPORT_MARGIN },
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
      if (retryTimer) clearTimeout(retryTimer)
      cancelCoverJob(key)
    }
    // onPosterReady 每次渲染都变，故意不进依赖，否则观察器反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.kind, poster, genFailed, playable])

  /** 图片类：进入视口才生成统一缩略图（与视频封面共用同一条预算队列，BUG-239）。 */
  useEffect(() => {
    if (poster || genFailed) return
    if (item.kind !== 'photo') return
    // BUG-250：无字节条目不发缩略图请求（photo+missing 的 /raw 走现场代理，
    // 虽返回 200，但对「已清缓存/已丢失」的条目请求它同样是无效流量）
    if (!playable) return
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const key = `p-${item.id}`
    let alive = true
    let visible = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const attempt = () => {
      if (!alive || !visible) return
      requestImageThumb(key, mediaThumbUrl(item.id, 480), 480).then(
        (u) => {
          if (!alive) return
          setPoster(u)
          onPosterReady?.({ id: item.id, poster: u })
        },
        (e) => {
          if (!alive) return
          if (isPosterBudgetDropped(e)) {
            if (visible) retryTimer = setTimeout(attempt, 1500)
            return
          }
          // 服务端缩略图不可用（未落盘 / HEIC 等解不动）⇒ 用**原图**再抽一次，
          // 别让「没有缩略图」变成「图没了」。
          requestImageThumb(`${key}-raw`, mediaItemUrl(item.id), 480).then(
            (u) => {
              if (!alive) return
              setPoster(u)
              onPosterReady?.({ id: item.id, poster: u })
            },
            () => {
              if (alive) setGenFailed(true)
            },
          )
        },
      )
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            visible = true
            attempt()
          } else {
            visible = false
            cancelCoverJob(key)
          }
        }
      },
      { rootMargin: COVER_VIEWPORT_MARGIN },
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
      if (retryTimer) clearTimeout(retryTimer)
      cancelCoverJob(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.kind, poster, genFailed, playable])

  const thumbSrc =
    playable && item.kind === 'photo'
      ? poster ?? (thumbUnavailable ? mediaItemUrl(item.id) : mediaThumbUrl(item.id, 480))
      : poster

  const recacheable = !playable && Boolean(onRecache)

  /**
   * BUG-305：这条内容的 TG 源坐标（`<chat>:<msg>` 解析结果）。
   * 本地来源 / 坐标缺失或不可解析 ⇒ null ⇒ 不渲染「在 TG 中查看」入口
   * （没有可跳的消息，就不给一个点了没反应的按钮）。
   */
  const tgCoords = parseSourceRef(item.ref, item.source)
  const canViewInTg = tgCoords !== null && Boolean(onViewInTg)

  /** 悬浮图标按类型取（BUG-123），未知类型退回中性「打开」 */
  const ActionIcon = KIND_ACTION_ICON[item.kind] ?? FALLBACK_ACTION_ICON

  /**
   * 徽标文案（BUG-128）：必须走 `useTranslation()`，**不能**裸 import 模块级 `t()`。
   *
   * 模块级 `t()` 读的是 `useStore.getState()`（i18n/index.ts），它自己**不订阅**语言；
   * 真正订阅 `settings.language` 的是 `useTranslation()`。而本组件外层包着 `memo`，
   * 裸 `t()` 会让用户切语言后卡片**不重渲染** —— 徽标停在上一个语言，直到别的 prop
   * 变了才顺带刷新。那正是本条缺陷最容易踩的坑，所以订阅必须挂在组件上。
   */
  const { t } = useTranslation()
  const kindKey = kindLabelKey(item.kind)
  const kindLabel = kindKey ? t(kindKey) : null
  /**
   * 来源标签（S2）：库只记录 `source` 这个可扩展的来源类型，**不感知 TG**。
   * 「是不是 TG」是展示层用 `sourceLabelKey` 问出来的，不是写死在卡片里的。
   */
  const sourceLabel = t(sourceLabelKey(item.source))

  /**
   * 显名（D24-A / BUG-310）：卡片名走**唯一**解析函数 ——
   * 「用户自定义集名 ＞ 剧名+集号（单集用剧名）＞ 来源原文」。
   * `item` 已带后端下发的剧集槽位派生字段（seriesTitle/seriesSeason/seriesEpisodeNo/
   * seriesEpisodeCount），故这里无需再拼上下文。此前直接 `item.title` 会让卡片名
   * 与剧集详情、播放器各说各话（BUG-310 的原象）。
   */
  const resolved = resolveDisplayName({ item, fallback: item.title })
  /**
   * BUG-240：**空标题必须有可辨识兜底**。
   *
   * 实测 86/320 条 TG 条目 `title` 为空（入库没落 caption，上游见 BUG-232），
   * 五层解析也取不到任何名字时卡片标题行渲染空串 ⇒ 一屏几十张「同形无字卡」，
   * 用户直接报成「大量重复数据」（其实 id/ref 全唯一）。这里补 `未命名 · #<id>`：
   * id 全局唯一 ⇒ 任意两张卡片的可见标题不再逐字相同（判据 1），
   * 且 `#<id>` 与「条目 #N」的行内叫法同源，用户能据此回查。
   * 无字节态的区分标记由下方 `item-nobytes` 区块与根节点 `data-bytes` 承担（判据 2）。
   */
  const displayName = resolved.trim() || `${t('player.untitled')} · #${item.id}`

  return (
    <div
      ref={boxRef}
      data-testid="media-card"
      data-item-id={item.id}
      /* BUG-240 判据 2：字节态要能被机检（不读 className / 文案）。 */
      data-bytes={playable ? 'present' : 'missing'}
      /* BUG-240 判据 1：标题走兜底时留痕，脚本可据此断言「兜底生效」。 */
      data-unnamed={resolved.trim() ? undefined : 'true'}
      className={[
        'group relative flex flex-col overflow-hidden rounded-lg border bg-surface transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'border-border-subtle/60 hover:border-accent/50',
      ].join(' ')}
    >
      {/* 封面区（16:9） */}
      <div className="relative block aspect-video w-full overflow-hidden bg-surface-2">
        {playable ? (
          <button
            type="button"
            onClick={(e) => {
              // 选择模式（任务 #9）：已有 ≥1 条选中时封面点击 = 切换选中，
              // 禁入播放详情（裁定原文「不应该能点击进入播放详情页面」）。
              // 显式 Ctrl/Cmd 点击在两种模式下都是切换选中（既有行为）。
              if (selectionMode || e.metaKey || e.ctrlKey) {
                onSelectToggle?.(item.id, e.shiftKey)
                return
              }
              onOpen(item)
            }}
            className="relative block h-full w-full"
            title={displayName}
            data-testid="media-card-cover"
          >
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt={displayName}
                loading="lazy"
                /* 缩略图端点 404（未落盘/解不动）⇒ 回落原图一次，之后不再试缩略图 */
                onError={() => {
                  if (item.kind === 'photo' && !poster && !thumbUnavailable) setThumbUnavailable(true)
                }}
                /* 图片类 `object-contain`：卡片几何统一（16:9），但图片**不裁切** */
                className={`h-full w-full ${coverFit(item.kind)}`}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-2xl text-muted">
                {genFailed ? '🚫' : KIND_ICON[item.kind] ?? '📄'}
              </span>
            )}

            {/* 悬浮操作层：图标按类型分流（BUG-123），不再是统一播放三角 */}
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-black">
                <ActionIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              {/* BUG-381：把「单击封面就是浏览入口」写成可见文字。用户报
                  「方格图小了、没有浏览功能」——浏览（MediaViewer 灯箱）
                  一直都在，但 200px 小图 + 无文字暗示让入口不可发现。
                  图放大（grid 240px）+ 这句话，两件事一起修。 */}
              <span className="rounded bg-black/70 px-1.5 text-[10px] font-medium text-white">
                {t('media.cardOpenHint')}
              </span>
            </span>

            {/* 时长徽标 */}
            {item.duration ? (
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
                {fmtDuration(item.duration)}
              </span>
            ) : null}
          </button>
        ) : (
          /* 无字节占位（BUG-080）：**不给播放入口** —— 一个点了必然 404 的按钮
             比没有按钮更糟，它把「没有字节」伪装成「可以播放」。
             封面位如实显示占位，TG 来源给「重新缓存」，其余标「文件已丢失」。 */
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted"
            data-testid="item-nobytes"
            title={
              recacheable
                ? recacheBlockedReason ?? t('media.recacheFrom', { source: sourceLabel })
                : t('media.fileMissingHint')
            }
          >
            <CloudOff className="h-5 w-5" />
            <span className="text-xs leading-none">
              {recacheable ? t('media.bytesCleared') : t('media.fileMissing')}
            </span>
            {recacheable ? (
              <button
                type="button"
                disabled={Boolean(recacheBlockedReason)}
                onClick={() => onRecache?.(item)}
                className={[
                  'rounded-full px-2 py-1 text-xs font-medium leading-none text-white transition-colors',
                  recacheBlockedReason
                    ? 'cursor-not-allowed bg-muted/40'
                    : 'bg-accent/90 hover:bg-accent',
                ].join(' ')}
                title={recacheBlockedReason ?? t('media.recacheFrom', { source: sourceLabel })}
                data-testid="item-recache"
              >
                {t('media.recache')}
              </button>
            ) : null}
          </div>
        )}

        {/* 集号徽标 */}
        {episodeLabel ? (
          <span className="absolute left-1 top-1 rounded bg-accent/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {episodeLabel}
          </span>
        ) : null}

        {/* 类型徽标（BUG-123）：不 hover 也能分辨图片/视频/音频。
            位置选**左下角**，理由是四角只剩它空着：左上 `left-1 top-1` 是集号徽标，
            右上 `right-1 top-1` 是多选勾选框，右下 `bottom-1 right-1` 是时长徽标
            （卡片右下角另有常驻的编辑/删除条）；左下既不冲突，又与右下的时长徽标
            同处一条基线，读起来像一组元信息。
            `pointer-events-none`：它压在封面按钮上，不能吞掉那一角的点击。 */}
        {kindLabel ? (
          <span
            className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white/90"
            data-testid="item-kind"
          >
            {kindLabel}
          </span>
        ) : null}

        {/* 多选勾选框（悬浮/选中时可见）。
            testid `media-card-select`：验收脚本据此进入选择模式
            （任务 #9：勾任意一条 → 浮动选择条出现）。 */}
        {onSelectToggle ? (
          <span
            role="checkbox"
            aria-checked={Boolean(selected)}
            data-testid="media-card-select"
            onClick={(e) => {
              e.stopPropagation()
              onSelectToggle(item.id, e.shiftKey)
            }}
            className={[
              'absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded border text-xs transition-opacity',
              selected
                ? 'border-accent bg-accent text-white opacity-100'
                : 'border-white/70 bg-black/40 text-transparent opacity-0 group-hover:opacity-100',
            ].join(' ')}
          >
            ✓
          </span>
        ) : null}
      </div>

      {/* 文本区 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2">
        {/*
          BUG-138 验收要钉「卡片显示的是新标题还是旧标题」，而卡片文本区同时渲染
          剧名（`· seriesTitle`）—— 改条目标题不该顺带改剧集名，整卡文本因此永远
          含着旧名。给显名行一个 testid，判据才钉得住标题本身。
        */}
        <p className="truncate text-sm font-medium text-fg-strong" title={displayName} data-testid="media-card-title">
          {displayName}
        </p>
        <p className="flex items-center gap-1 truncate text-xs text-muted">
          {/*
           * BUG-133：这里的 `item.size` 是**登记值**（源头元数据），不是本地磁盘占用。
           * 此前它被裸展示成一个和「占用空间」毫无区别的数字，两处读数被当成同一口径，
           * 于是清缓存后卡片没变、用户以为字节没回收。改为显式标注口径。
           *
           * 逐条的真实占盘字节没有下发（那需要为每张卡片 stat 一次，列表页不可接受），
           * 故这里只做**口径标注**、不编造数字 —— 未落盘/已清字节的内容照样显示登记值，
           * 但读的人知道那不是磁盘事实。
           */}
          <span title={t('media.card.sizeTitle')}>
            {fmtSize(item.size)}
          </span>
          {/* 来源徽标（S2）：一眼分清这条内容是从哪来的 */}
          <span
            className="shrink-0 rounded bg-surface-2/70 px-1.5 py-0.5 text-[11px] leading-none text-muted"
            data-testid="item-source"
            title={t('media.fromSource', { source: sourceLabel })}
          >
            {sourceLabel}
          </span>
          {item.seriesTitle ? <span className="truncate">· {item.seriesTitle}</span> : null}
        </p>
        {item.tags.length > 0 ? (
          <p className="flex flex-wrap gap-x-1 gap-y-0.5 pt-0.5" data-testid="item-tags">
            {/* 全量展示：省略成「+N」会让标签看起来像没归档（>3 个时尤其明显）。 */}
            {item.tags.map((tag) => (
              <TagToken key={tag.id} name={tag.name} />
            ))}
          </p>
        ) : null}
      </div>

      {/*
       * 卡片操作条：**常驻可见**（编辑 + 删除）。
       *
       * 编辑入口曾经写成 `opacity-0 group-hover:opacity-100` —— 只有把鼠标悬停到封面正中央
       * 才显形，用户根本找不到「标题在哪儿改」，于是反馈「剧集和视频的标题不能编辑」。
       * 功能存在但入口不可发现，等于没有。删除入口同理，且它比删除更依赖「一眼看到」：
       * 找不到删除的人会去勾选，于是又把「选择」当成删除的前置仪式。
       *
       * 2026-10-20（BUG-328）：原先是 `absolute bottom-1 right-1`，实测**每张卡都压住
       * 标签行 106×21px**（操作条 112px 宽，标签行 208px）—— 标签被「删除/编辑」盖掉，
       * 这正是「内容看不清」的一部分。改成卡片内的**正常流式一行**（带分隔线、右对齐），
       * 不再与文字抢同一块像素；卡片高度多一行，换来的是一行都读得全。
       */}
      {onEdit || onDelete || canViewInTg ? (
        <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border-subtle/40 px-1.5 py-1">
          {tgCoords && onViewInTg ? (
            <button
              type="button"
              onClick={() => onViewInTg?.(tgCoords)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-mid transition-colors hover:bg-surface-2 hover:text-fg-strong"
              title={t('media.viewInTg')}
              aria-label={t('media.viewInTg')}
              data-testid="item-view-tg"
            >
              <Send className="h-3 w-3" />
              {t('media.viewInTg')}
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-mid transition-colors hover:bg-destructive hover:text-white"
              title={t('media.card.deleteTitle')}
              aria-label={t('media.card.deleteAria')}
              data-testid="item-delete"
            >
              <Trash2 className="h-3 w-3" />
              {t('media.card.delete')}
            </button>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-fg-mid transition-colors hover:bg-surface-2 hover:text-fg-strong"
              title={t('media.card.editTitle')}
              aria-label={t('media.card.editAria')}
              data-testid="item-edit"
            >
              <Pencil className="h-3 w-3" />
              {t('media.card.edit')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 记忆化导出：网格里上百张卡，props 不变就不重渲染（见文件头说明）。 */
export const MediaCard = memo(MediaCardBase)
