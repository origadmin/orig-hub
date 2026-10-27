import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from './ui/button'
import { useTranslation } from '../i18n'
import { setPosterExtractionPaused } from '../lib/poster'
import { episodeRecacheCandidates, recacheFromSource } from '../lib/mediaSources'
import { cn } from '../lib/utils'
import { VideoPlayer } from './media/VideoPlayer'
import { EpisodeList } from './media/EpisodeList'
import { useSeriesDetail } from '../hooks/useSeriesDetail'
import type { ViewerItem } from '../types'

/**
 * 内容的**使用方式**（不是类型别名 —— 它决定播放组如何分流）。
 *
 *   play    → 连续播放（视频 / 音频），有播放控件、自动连播
 *   browse  → 逐张浏览（图片），只有翻页，没有播放语义
 *   none    → 不支持预览（如文档/压缩包）
 *
 * 为什么必须分流：剧集可能是混合内容（实测某剧集 = 5 视频 + 3 图片）。
 * 若把图片也编进播放序列，播完第 2 集会「自动连播到第 3 集（图片）」——
 * 即用户报的「视频和图片全部作为视频播放了，从没见过播放图片的电影」。
 * 分流后：点视频 → 组内只有视频（连着播）；点图片 → 组内只有图片（连着翻）。
 */
type Mode = 'play' | 'browse' | 'none'
const modeOf = (k: ViewerItem['kind'] | undefined): Mode =>
  k === 'photo' ? 'browse' : k === 'video' || k === 'audio' ? 'play' : 'none'

/**
 * BUG-459：右侧侧栏 TAB 的**会话内**记忆（不持久化、不写 store）。
 *
 * 裁定：进入播放默认「介绍」；用户手切「列表」后本次会话内记住 —— 用模块级变量
 * 而非 state，是为了在播放器卸载/重挂载（换集、返回再进）后仍保留用户的选择。
 */
let sessionSideTab: 'list' | 'info' = 'info'

/**
 * 全局媒体播放器页（模块无关，不带任何模块信息）：打开时独占内容区整页。
 * 返回行（← 返回 + 标题 + 位置/总数）+ 媒体区（‹ › 收在面板内侧，不会出框）+ caption 底部行。
 *
 * 视频交给 `media/VideoPlayer`（自绘控件，含快捷键/倍速/画中画/自动连播）；
 * 图片走 `<img>` 浏览（无播放控件）；当播放项带 `seriesId` 时右侧挂分集列表 ——
 * 侧栏列出**整部剧集**（含另一种类型），点哪一项就切到哪种模式。
 *
 * 键盘（**与播放器内部快捷键刻意分工，互不重叠**）：
 *   ←/→ 组内上一个/下一个，Esc 返回
 *   播放器内部：Space/K 播放暂停、J/L 快退快进 10s、↑/↓ 音量、M 静音、F 全屏、P 画中画
 */
export function MediaViewer(props: {
  items: ViewerItem[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  /** 返回行标题；缺省用当前项 caption / #messageId */
  title?: string
  className?: string
}) {
  const { t, language } = useTranslation()
  const { items, index, onIndex, onClose, title, className } = props
  const cur = items[index]

  /** 图片降级失败（视频的失败由 VideoPlayer 内部处理） */
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => setImgFailed(false), [cur?.key])

  /**
   * 播放让路（BUG-239 预算门 3）：播放器打开期间**暂停封面抽帧**。
   *
   * 播放器是盖在网格之上的覆盖层，网格与其卡片**仍然挂载**——若不暂停，被覆盖的
   * 卡片会继续排进解码队列，与正在播放的视频争解码/IO（实测播放中 `currentTime`
   * 只推进 0.72×，即用户体感的卡顿）。挂载置位、卸载复位：用户正在看的内容优先。
   */
  useEffect(() => {
    setPosterExtractionPaused(true)
    return () => setPosterExtractionPaused(false)
  }, [])

  const seriesId = cur?.seriesId ?? null
  /**
   * 有剧集归属就显示侧栏 —— **刻意不按媒体类型过滤**。
   * 剧集可能是混合内容（实测某剧集 = 3 个视频 + 7 张图片）。若只对视频显示，
   * 用户点到图片那一集时侧栏会突然消失，此后再也无法切回视频集 ——
   * 这正是「点了没反应 / 列表没了」的成因。
   */
  const showEpisodes = Boolean(seriesId)
  /** 分集数据（单一来源）：侧栏列表与「即将播放 第 N 集」标注共用同一份 */
  const { detail, loading, error, notFound } = useSeriesDetail(seriesId)

  const mode = modeOf(cur?.kind)
  /**
   * BUG-459：侧栏两档 —— 「介绍」（本集/本剧正文，左对齐可滚动）/「列表」（现状分集列表）。
   * 根因：侧栏可见性只由 `showEpisodes && seriesId`（数据结构）决定，与「此刻要不要看列表」
   * 无关 ⇒ 播放全程 300px 恒被不看的东西占着，而要看的是底部 96px 窄条。
   * 默认值按模式分：播放 → 「介绍」（用户原话「播放时不看列表，看文字介绍就够」）；
   * 浏览 / 选集 → 「列表」（与改动前逐像素一致，BUG-451 回归面只落在播放态）。
   */
  const [sideTab, setSideTab] = useState<'list' | 'info'>(
    mode === 'browse' ? 'list' : sessionSideTab,
  )
  const chooseSideTab = (k: 'list' | 'info') => {
    setSideTab(k)
    if (mode !== 'browse') sessionSideTab = k
  }
  /** 本集正文（与剧集详情同一段文本的两个来源：条目介绍优先，退回 caption） */
  const episodeText = (cur?.description ?? '').trim() || (cur?.caption ?? '').trim()
  /**
   * 重缓存坐标（BUG-261）：判据从「当前主源」换成「这一集的任一可用来源」。
   *
   * 主源不可缓存（local / ref 缺失）时，直接用该剧集里同一分集的 tg 备用源 ref
   * 下发 —— 「有字节可切换、无字节可缓存」用的是同一个 ref 集合，不再要求用户
   * 先「切换来源」。当前项不属于任何剧集（TG 流打开）时退回主源坐标，行为不变。
   */
  const recacheCandidates = useMemo(() => {
    if (!cur) return []
    const ep = detail?.episodes.find((e) => e.itemId === cur.messageId)
    return episodeRecacheCandidates({
      source: cur.source,
      ref: cur.ref,
      sources: ep?.sources ?? [],
    })
  }, [cur, detail])
  /**
   * 当前组 = 同一使用方式的内容。
   *
   * `items` 仍是**全量**（`viewer.index` 指向它，契约不变），组是派生的：
   * 侧栏点另一种类型 → 全量 index 变化 → 组的 kind 跟着变 → 自动换模式。
   * 不需要任何跨层回调，也不会出现「播放组里混进图片」。
   */
  const group = useMemo(
    () => (cur ? items.filter((i) => modeOf(i.kind) === mode) : []),
    [items, cur, mode],
  )
  const curKey = cur ? String(cur.key) : ''
  const posInGroup = group.findIndex((i) => String(i.key) === curKey)
  const prevItem = posInGroup > 0 ? group[posInGroup - 1] : null
  const nextItem =
    posInGroup >= 0 && posInGroup < group.length - 1 ? group[posInGroup + 1] : null
  /**
   * BUG-444：**自动连播**只推进「可播子集」。
   *
   * 原缺陷：`group` 只按 `kind` 分流，**不看有没有字节** —— 「播放全部」从可播子集起播，
   * 但播完一集后的自动推进仍按全量组走，于是下一集可能是一条 `hasBytes === false`
   * 的无字节视频：播放器落到「未缓存」态，连播就此停住（用户体感「连播坏在不该停的地方」）。
   *
   * 修法边界（刻意不做的事）：只收窄**自动推进**这一条路。分集侧栏的 `isSelectable`、
   * ‹ › 上一条/下一条、←/→ 键位仍是**全量组** —— 用户想手动点一条无字节集查看原因，
   * 这条通路必须留着（「可点范围」与「自动推进范围」是两回事，不能合并）。
   */
  const autoNext = useMemo(() => {
    if (posInGroup < 0) return null
    return group.slice(posInGroup + 1).find((i) => i.hasBytes !== false) ?? null
  }, [group, posInGroup])

  /** 组内跳转：把目标项换算回全量 index（store 契约不变） */
  const goTo = (it: ViewerItem) => {
    const idx = items.findIndex((x) => String(x.key) === String(it.key))
    if (idx >= 0 && idx !== index) onIndex(idx)
  }

  const many = group.length > 1

  // 键盘导航：←/→ 组内切换，Esc 返回（组件自持，任何挂载处行为一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        if (prevItem) goTo(prevItem)
      } else if (e.key === 'ArrowRight') {
        if (nextItem) goTo(nextItem)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevItem, nextItem, index, items, onIndex, onClose])

  // 分集列表点击：在**全量** items 内按 itemId 定位（媒体库里 messageId 即 MediaItem.id）。
  // 定位到另一种类型也没关系 —— 上面的 group 会随之切换模式。
  const selectEpisode = (itemId: number) => {
    const idx = items.findIndex((it) => it.messageId === itemId)
    if (idx >= 0 && idx !== index) onIndex(idx)
  }
  const isSelectable = (itemId: number) => items.some((it) => it.messageId === itemId)

  // BUG-444：连播的「即将播放」与预载都按 `autoNext`（可播子集），不是 `nextItem`（全量组）。
  const       nextUp = autoNext
    ? {
        title: autoNext.caption?.trim() || t('player.untitled'),
        poster: autoNext.poster,
        episodeNo:
          autoNext.episodeNo ??
          detail?.episodes.find((e) => e.itemId === autoNext.messageId)?.episodeNo ??
          null,
      }
    : null

  if (!cur) return null

  const browse = mode === 'browse'
  /** 位置文案：浏览说「第 n 张」，播放在剧集里说「第 n 集」，否则只说位次 */
  const positionText = (() => {
    if (posInGroup < 0 || group.length <= 1) return null
    const n = posInGroup + 1
    if (browse) return t('player.photoPos', { n, total: group.length })
    if (cur.episodeNo) return t('player.episodePos', { n: cur.episodeNo, total: group.length })
    return `${n}/${group.length}`
  })()

  return (
    <div
      className={cn('flex min-h-0 flex-col bg-surface/20', className)}
      data-testid="media-viewer"
      data-message-id={cur.messageId}
    >
      {/* 返回行：← 返回 + 标题 + 位置/总数 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={onClose}
        >
          ← {t('tg.backToFeed')}
        </Button>
        {/* 图片模式下显式标出「浏览」，避免用户以为在播放 */}
        {browse && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-mid">
            <ImageIcon className="h-3 w-3" />
            {t('player.browse')}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-muted"
          data-testid="viewer-title"
        >
          {title || cur.caption?.trim() || t('player.untitled')}
        </span>
        {positionText && (
          <span
            className="shrink-0 text-[11px] tabular-nums text-muted"
            data-testid="viewer-position"
          >
            {positionText}
          </span>
        )}
      </div>

      {/* 主体：媒体区 + 分集侧栏 */}
      <div className="flex min-h-0 flex-1">
        {/*
          BUG-416 合并播放（连播不断档）：切到下一集前先**预载字节**。
          这个隐藏 video 以 `autoNext.src` 为 key，跨集切换时 MediaViewer 不卸载，
          故预载不被打断；下一集 `<VideoPlayer>` 挂载时字节已在 HTTP 缓存中，
          切换如同单视频续播，不再「重新加载」。
          BUG-444：预载目标与连播目标必须同一份（`autoNext`）—— 预载全量组的下一集、
          却连播可播子集的下一集，等于每次都预载错的那条。
        */}
        {autoNext?.src ? (
          <video
            key={autoNext.src}
            src={autoNext.src}
            preload="auto"
            muted
            playsInline
            aria-hidden="true"
            style={{ display: 'none' }}
            data-testid="next-episode-preload"
          />
        ) : null}

        {/* 媒体区：黑底居中；‹ › 组内切换收在面板两侧，不再出框 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black">
          {many && prevItem && (
            <button
              type="button"
              aria-label={browse ? t('player.prevPhoto') : t('player.prevItem')}
              onClick={() => goTo(prevItem)}
              data-testid="viewer-prev"
              className="absolute left-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
            >
              ‹
            </button>
          )}

          {browse ? (
            <img
              key={String(cur.key)}
              src={cur.src}
              alt={cur.caption || ''}
              className="max-h-full max-w-full rounded-lg object-contain"
              onError={(e) => {
                const img = e.currentTarget
                if (cur.fallbackSrc && !img.dataset.fallback) {
                  img.dataset.fallback = '1'
                  img.src = cur.fallbackSrc
                } else {
                  setImgFailed(true)
                }
              }}
            />
          ) : mode === 'play' ? (
            <VideoPlayer
              key={String(cur.key)}
              src={cur.src}
              fallbackSrc={cur.fallbackSrc}
              poster={cur.poster}
              autoPlay
              nextUp={nextUp}
              /* BUG-444：连播推进走 `autoNext`（可播子集）；`›` 按钮与 ←/→ 仍是全量组。 */
              onPlayNext={() => autoNext && goTo(autoNext)}
              hasVideoTrack={cur.kind === 'video'}
              /*
               * 兼容流（BUG-208）：视频条目解码不支持时自动切服务端实时转码。
               *
               * BUG-434：**不再在这里拼地址**。原写法是
               * `mediaItemStreamUrl(cur.messageId)` —— 但 `messageId` 在 TG 场景下是
               * Telegram 消息号，拼出来的是 `/api/media/items/<tgMsgId>/stream`
               * 这条跨域错位的死链（实测 404）；播放器还因 stream-first 先起在它上面，
               * 白等一轮错误才回退到真正能用的 `/api/tg/file/...`，用户看到的就是
               * 「后台一直在加载、画面还是展示界面」。
               * 现在由调用方用 `streamSrc` 显式声明「我这条有转码流」，TG 不填。
               */
              compatSrc={cur.kind === 'video' ? cur.streamSrc : undefined}
              // BUG-253：真源总时长（来自 `GET /api/media/items/<id>` 的 duration 字段），
              // 播放器据此显示正确总数，不取 live 转码流的瞬时 `video.duration`。
              duration={cur.duration ?? undefined}
              // BUG-254：透传字节态；无字节时播放器渲染专属「无内容 / 未缓存」态，
              // 并给出「重新缓存」入口（按来源定位符重抓）。
              // BUG-261：坐标 = 这一集任一可用来源（主源优先，备用源兜底），
              // 无候选（无 ref 坐标）时隐藏入口而不是给一个必然失败的按钮。
              hasBytes={cur.hasBytes}
              onRecache={
                recacheCandidates.length > 0
                  ? () => {
                      const c = recacheCandidates[0]
                      void recacheFromSource(c.ref, c.source).catch(() => {
                        /* 入队失败静默与既有行为一致：播放器内无错误展示面 */
                      })
                    }
                  : undefined
              }
            />
          ) : (
            <p className="max-w-[80%] rounded-md border border-white/20 bg-white/5 px-3 py-2 text-center text-xs text-white/85">
              {t('player.unsupported')}
            </p>
          )}

          {many && nextItem && (
            <button
              type="button"
              aria-label={browse ? t('player.nextPhoto') : t('player.nextItem')}
              onClick={() => goTo(nextItem)}
              data-testid="viewer-next"
              className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
            >
              ›
            </button>
          )}

          {imgFailed && (
            <p className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-center text-xs text-white/85">
              {t('tg.decodeFail')}
            </p>
          )}
        </div>

        {showEpisodes && seriesId && (
          /* BUG-459：右侧由「恒为 300px 列表」改为「300px 两档 TAB」。宽度不变
             （`EpisodeList` 的 `w-[300px]` 契约保留，这里显式覆盖成容器宽度），
             面板内部多一条 TAB 行 —— 画面宽度、连播预载挂载位置都不动。 */
          <aside
            className="flex w-[300px] shrink-0 flex-col border-l border-border-subtle/60 bg-surface/30"
            data-testid="viewer-side"
            aria-label={t('player.episodes')}
          >
            <div
              className="flex shrink-0 items-center gap-1 border-b border-border-subtle/60 px-2 py-1.5"
              data-testid="viewer-side-tabs"
            >
              <button
                type="button"
                onClick={() => chooseSideTab('list')}
                aria-pressed={sideTab === 'list'}
                data-testid="viewer-tab-list"
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  sideTab === 'list'
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-fg-mid',
                )}
              >
                {t('player.episodes')}
              </button>
              <button
                type="button"
                onClick={() => chooseSideTab('info')}
                aria-pressed={sideTab === 'info'}
                data-testid="viewer-tab-info"
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  sideTab === 'info'
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-fg-mid',
                )}
              >
                {/* 无现成 key（不新增 i18n 键，见报告「需主控补 key」） */}
                {language !== 'en-US' ? '介绍' : 'Info'}
              </button>
            </div>

            {sideTab === 'list' ? (
              <EpisodeList
                title={detail?.title ?? ''}
                episodes={detail?.episodes ?? []}
                loading={loading}
                error={error}
                notFound={notFound}
                currentItemId={cur.messageId}
                onSelect={selectEpisode}
                isSelectable={isSelectable}
                /* 宽度交给外层 300px 容器；边框由容器承担，避免双线 */
                embedded
              />
            ) : (
              <div
                className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
                data-testid="viewer-info"
              >
                {detail?.title ? (
                  <p
                    className="truncate text-[12px] font-medium text-fg-strong"
                    title={detail.title}
                  >
                    {detail.title}
                  </p>
                ) : null}
                <p className="mt-0.5 text-[10px] tabular-nums text-muted">
                  {cur.episodeNo ? t('player.episodeN', { n: cur.episodeNo }) : t('player.browse')}
                </p>
                {/* 正文 = 与剧集详情同一段文字，左对齐、可滚动、字号一致（不是居中窄条） */}
                <p className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                  {episodeText || t('media.descEmptyEp')}
                </p>
                {detail?.description && detail.description.trim() !== episodeText ? (
                  <>
                    <p className="mt-3 text-[11px] font-medium text-fg-strong">
                      {t('media.series.editDesc')}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                      {detail.description}
                    </p>
                  </>
                ) : null}
              </div>
            )}
          </aside>
        )}
      </div>

      {/*
       * 底部文案行：媒体库条目**优先显示介绍**。
       *
       * 条目的 `caption` 在媒体库场景被填成标题（返回行已经显示了一遍），
       * 若这里再显示 caption，同一个标题会出现两次、而真正的正文无处可看 ——
       * 这正是「视频内容错误」的观感来源。有 `description` 就显示它。
       *
       * `whitespace-pre-wrap` 与剧集详情（`SeriesDetail`）的正文渲染**必须一致**：
       * 介绍是多段文本，折叠换行会把分段吃掉 —— 同一段正文在剧集页有分段、
       * 在播放页变成一坨，就是「剧集对、视频错」的又一种形态。
       */}
      {/*
        BUG-459 裁定：底部 `viewer-text` 条撤销 —— 同一段正文在「介绍」TAB 与底部条
        两处显示即为重复真源，只能留一个。**仅当没有侧栏「介绍」TAB 时**（无剧集归属的
        单条内容 / 图片）才保留：那时它是正文的唯一呈现点，删掉等于丢能力（BUG-149）。
      */}
      {!showEpisodes && (cur.description?.trim() || cur.caption?.trim()) && (
        <p
          className="max-h-24 shrink-0 overflow-y-auto whitespace-pre-wrap break-words border-t border-border-subtle/60 bg-black px-4 py-2 text-center text-xs text-white/80 [overflow-wrap:anywhere]"
          data-testid="viewer-text"
        >
          {cur.description?.trim() || cur.caption}
        </p>
      )}

      {/*
       * 图片轮播带（browse 模式且组内多图）。
       *
       * 为什么必须有：多图剧集（或一次加入的多张图）此前只能靠 ‹ › 一张张翻，
       * 用户无法知道「这组一共几张、还剩哪些」——即「多张图加入后没有完整展示」。
       * 缩略图带把**整组图片一次摆出来**：当前张高亮、点任意一张直接切过去，
       * 位置与顺序一眼可见。
       *
       * 只对图片（browse）出现：视频/音频的顺序导航由分集侧栏承担，
       * 再挂一条缩略带是重复的第二套控件。
       *
       * 缩略图用 `object-cover` 是**刻意**的：48px 的方格里它是「索引」而非内容，
       * 内容由上方大图完整呈现（`object-contain`，绝不裁切）。
       */}
      {browse && group.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-border-subtle/60 bg-black px-3 py-2">
          {group.map((it, i) => {
            const on = String(it.key) === curKey
            return (
              <button
                key={String(it.key)}
                type="button"
                onClick={() => goTo(it)}
                aria-current={on ? 'true' : undefined}
                aria-label={t('player.photoPos', { n: i + 1, total: group.length })}
                title={it.caption?.trim() || t('player.untitled')}
                data-testid="photo-strip-item"
                className={cn(
                  'relative h-12 w-12 shrink-0 overflow-hidden rounded border transition-all',
                  on
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-white/15 opacity-65 hover:opacity-100',
                )}
              >
                <img
                  src={it.poster ?? it.src}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[9px] tabular-nums text-white">
                  {i + 1}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
