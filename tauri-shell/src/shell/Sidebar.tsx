import { useState } from 'react'
import { cn } from '../lib/utils'
import { useTranslation } from '../i18n'
import {
  DL_FILTERS,
  FILE_CATEGORIES,
  isNavChildActive,
  type DlFilter,
  type FileCategory,
  type FileMode,
  type NavState,
  type SettingsSection,
  type ViewId,
} from '../nav'

/**
 * 侧栏：五项一级域 + 两棵树（模块重整 M0 · BUG-298 / M0-T01）。
 *
 * 与 M0 前的最小差异（契约细节见 `nav/index.ts`）：
 *  1. `ViewId` 收五域，**下载三档与文件分类不再是顶级导航位**，而是各自树下的子项；
 *  2. TG 入口**常驻**：M0 前 `tgReady` 为 false 时整项消失 ⇒ 用户既看不到入口、
 *     也看不到引导。门控移入 TgPanel 内部空状态（M0-T05），本组件不再感知 TG 就绪态；
 *  3. chevron 两棵树各自独立展开、不互斥（原「全部文件」的 chevron 双点击区原语沿用）。
 */

interface Props {
  nav: NavState
  onNavigate: (view: ViewId, opts?: { dlFilter?: DlFilter; fmode?: FileMode; section?: SettingsSection }) => void
  collapsed: boolean
  onToggle: () => void
  counts: {
    /** 成品总数（文件父行徽标） */
    files: number
    /** 下载中档（含 queued | idle） */
    downloading: number
    paused: number
    completed: number
    series: number
    tags: number
    /** 未归档数：**可空**（后端无该统计，禁止编造；见 nav/index.ts） */
    unfiled?: number
  }
}

const FolderIcon = (
  <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75A2.25 2.25 0 014.5 4.5h3.879a2.25 2.25 0 011.59.659l1.171 1.171a2.25 2.25 0 001.59.659H19.5a2.25 2.25 0 012.25 2.25v8.25A2.25 2.25 0 0119.5 19.5H4.5A2.25 2.25 0 012.25 17.25V6.75z" />
  </svg>
)

const DownloadIcon = (
  <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
  </svg>
)

const TgIcon = (
  <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
)

const ShareIcon = (
  <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
  </svg>
)

const SettingsIcon = (
  <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
)

const ChevronIcon = (
  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
  </svg>
)

/** 分类子项的种类 → i18n key（缺失回退分类英文名）。 */
const CATEGORY_KEY: Record<FileCategory, string> = {
  video: 'files.cat.video',
  music: 'files.cat.music',
  image: 'files.cat.image',
  doc: 'files.cat.doc',
  archive: 'files.cat.archive',
  other: 'files.cat.other',
}

const DL_KEY: Record<Exclude<DlFilter, 'all'>, string> = {
  running: 'download.running',
  paused: 'download.paused',
  done: 'download.done',
}

const LIB_KEY: Record<'series' | 'tags' | 'unfiled', string> = {
  series: 'files.lib.series',
  tags: 'files.lib.tags',
  unfiled: 'files.lib.unfiled',
}

export function Sidebar({ nav, onNavigate, collapsed, onToggle, counts }: Props) {
  const { t } = useTranslation()
  const [filesOpen, setFilesOpen] = useState(true)
  const [dlOpen, setDlOpen] = useState(true)

  const { view, fmode, dlFilter } = nav
  const filesActive = view === 'files'
  const dlActive = view === 'download'

  /** 父行底色（与一级项同一原语，保证「父行/子项/一级项」三态视觉一致）。 */
  const rowCls = (active: boolean) =>
    cn(
      'flex w-full items-center rounded-md px-2.5 py-2 text-sm transition-all duration-200',
      active ? 'bg-accent/15 text-accent' : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
    )

  const childCls = (active: boolean) =>
    cn(
      'flex w-full items-center gap-2 rounded-md py-1.5 pl-9 pr-2.5 text-[13px] transition-colors',
      active ? 'bg-accent/15 text-accent' : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
    )

  const GroupLabel = ({ children }: { children: string }) => (
    <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">{children}</p>
  )

  const Count = ({ n }: { n: number }) =>
    n > 0 ? (
      <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-fg-soft">
        {n}
      </span>
    ) : null

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border-subtle bg-surface transition-all duration-300 ease-out',
        collapsed ? 'w-12' : 'w-48',
      )}
    >
      {/* Logo + 折叠/展开 */}
      <div className={cn('flex h-12 items-center gap-2 px-3', collapsed ? 'justify-center' : 'justify-between')}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/20">
            <span className="text-xs font-bold text-accent">O</span>
          </div>
          {!collapsed && <span className="truncate text-sm font-semibold text-fg-strong">Orig Hub</span>}
        </div>
        {!collapsed && (
          <button
            onClick={onToggle}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
            title={t('sidebar.collapse')}
            aria-label={t('sidebar.collapse')}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={onToggle}
          className="mx-auto mb-1 flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
          title={t('sidebar.expand')}
          aria-label={t('sidebar.expand')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      )}

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-hidden px-2">
        <GroupLabel>{t('nav.group.manage')}</GroupLabel>

        {/* ── 文件树 ───────────────────────────────────────────── */}
        <div>
          {collapsed ? (
            <button
              onClick={() => onNavigate('files', { fmode: 'cat-all' })}
              title={t('nav.all')}
              aria-label={t('nav.all')}
              data-testid="nav-files"
              className={cn(rowCls(filesActive), 'justify-center px-0')}
            >
              {FolderIcon}
            </button>
          ) : (
            <div data-testid="nav-files-row" className={rowCls(filesActive)}>
              <button
                onClick={() => onNavigate('files', { fmode: 'cat-all' })}
                title={t('nav.all')}
                data-testid="nav-files"
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="shrink-0">{FolderIcon}</span>
                <span className="min-w-0 flex-1 truncate text-left">{t('nav.all')}</span>
                <Count n={counts.files} />
              </button>
              <button
                onClick={() => setFilesOpen((o) => !o)}
                title={t('sidebar.toggleCategories')}
                aria-label={t('sidebar.toggleCategories')}
                aria-expanded={filesOpen}
                data-testid="files-chevron"
                className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-60 transition-all duration-200 hover:opacity-100"
              >
                <span className={cn('transition-transform duration-200', filesOpen && 'rotate-90')}>{ChevronIcon}</span>
              </button>
            </div>
          )}

          {filesOpen && !collapsed && (
            <div className="mt-0.5 space-y-0.5">
              <p className="px-2 pb-0.5 pl-9 text-[10px] font-medium uppercase tracking-wide text-muted">
                {t('files.group.category')}
              </p>
              {FILE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  data-testid={`nav-child-${cat}`}
                  onClick={() => onNavigate('files', { fmode: `cat:${cat}` })}
                  title={t(CATEGORY_KEY[cat])}
                  className={childCls(isNavChildActive(view, fmode, dlFilter, { fmode: `cat:${cat}` }))}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{t(CATEGORY_KEY[cat])}</span>
                </button>
              ))}

              <p className="px-2 pb-0.5 pl-9 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                {t('files.group.library')}
              </p>
              {(['series', 'tags', 'unfiled'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  data-testid={`nav-child-lib-${g}`}
                  onClick={() => onNavigate('files', { fmode: `lib-${g}` as FileMode })}
                  title={t(LIB_KEY[g])}
                  className={childCls(isNavChildActive(view, fmode, dlFilter, { fmode: `lib-${g}` as FileMode }))}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{t(LIB_KEY[g])}</span>
                  {(() => {
                    // 未归档计数可空：没有就不显示，**不补 0**（0 = 「确认没有」，
                    // 与「不知道」是两件事，侧栏徽标不允许把后者伪装成前者）。
                    const n =
                      g === 'series' ? counts.series : g === 'tags' ? counts.tags : counts.unfiled
                    return n == null ? null : <span className="shrink-0 text-[10px] text-muted">{n}</span>
                  })()}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── 下载树 ───────────────────────────────────────────── */}
        <div>
          {collapsed ? (
            <button
              onClick={() => onNavigate('download', { dlFilter: 'all' })}
              title={t('nav.download')}
              aria-label={t('nav.download')}
              data-testid="nav-download"
              className={cn(rowCls(dlActive), 'justify-center px-0')}
            >
              {DownloadIcon}
            </button>
          ) : (
            <div data-testid="nav-download-row" className={rowCls(dlActive)}>
              <button
                onClick={() => onNavigate('download', { dlFilter: 'all' })}
                title={t('nav.download')}
                data-testid="nav-download"
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="shrink-0">{DownloadIcon}</span>
                <span className="min-w-0 flex-1 truncate text-left">{t('nav.download')}</span>
                <Count n={counts.downloading} />
              </button>
              <button
                onClick={() => setDlOpen((o) => !o)}
                title={t('download.toggleBuckets')}
                aria-label={t('download.toggleBuckets')}
                aria-expanded={dlOpen}
                data-testid="download-chevron"
                className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-60 transition-all duration-200 hover:opacity-100"
              >
                <span className={cn('transition-transform duration-200', dlOpen && 'rotate-90')}>{ChevronIcon}</span>
              </button>
            </div>
          )}

          {dlOpen && !collapsed && (
            <div className="mt-0.5 space-y-0.5">
              {DL_FILTERS.filter((f) => f !== 'all').map((f) => (
                <button
                  key={f}
                  type="button"
                  data-testid={`nav-child-dl-${f}`}
                  onClick={() => onNavigate('download', { dlFilter: f })}
                  title={t(DL_KEY[f])}
                  className={childCls(isNavChildActive(view, fmode, dlFilter, { dlFilter: f }))}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{t(DL_KEY[f])}</span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {f === 'running' ? counts.downloading : f === 'paused' ? counts.paused : counts.completed}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <GroupLabel>{t('nav.group.plugins')}</GroupLabel>
        <button
          onClick={() => onNavigate('tg')}
          title={t('nav.tg')}
          data-testid="nav-tg"
          className={cn(rowCls(view === 'tg'), collapsed && 'justify-center px-0')}
        >
          <span className="shrink-0">{TgIcon}</span>
          {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{t('nav.tg')}</span>}
        </button>

        <GroupLabel>{t('nav.group.external')}</GroupLabel>
        <button
          onClick={() => onNavigate('share')}
          title={t('nav.share')}
          data-testid="nav-share"
          className={cn(rowCls(view === 'share'), collapsed && 'justify-center px-0')}
        >
          <span className="shrink-0">{ShareIcon}</span>
          {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{t('nav.share')}</span>}
        </button>

        <div className="my-1 border-t border-border-subtle" />

        <button
          onClick={() => onNavigate('settings', { section: 'general' })}
          title={t('nav.settings')}
          data-testid="nav-settings"
          className={cn(rowCls(view === 'settings'), collapsed && 'justify-center px-0')}
        >
          <span className="shrink-0">{SettingsIcon}</span>
          {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{t('nav.settings')}</span>}
        </button>
      </nav>
    </aside>
  )
}
