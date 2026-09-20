import { useState, type JSX } from 'react'
import { cn } from '../lib/utils'
import { useTranslation } from '../i18n'

export type ViewId = 'all' | 'downloading' | 'completed' | 'media' | 'tg' | 'settings'

interface Props {
  view: ViewId
  onViewChange: (v: ViewId) => void
  /** 自动分类清单（来自 daemon classify_rules 去重）；「全部文件」下钻子项 */
  categories: string[]
  /** 当前选中的分类（null = 不过滤） */
  categoryFilter: string | null
  onCategoryChange: (c: string | null) => void
  collapsed: boolean
  onToggle: () => void
  counts: { active: number; completed: number; total: number }
  /** Telegram 已绑定/已登录（由登录绑定态驱动） */
  tgBound: boolean
  /** TG 功能就绪（常规开关开 + 可用性探测 ok）；false 时 TG 导航整体隐藏（入口级门控） */
  tgReady: boolean
}

/**
 * 隐藏下载模块（可逆开关）。
 *
 * 依据：用户裁定「下载不需要，因为不使用这个下载逻辑」——主流程是 TG 抓取 → 缓存入库 →
 * 媒体库管理/播放，不经过 orig-daemon 的下载任务队列。置 false 即可恢复全部下载入口。
 */
const DOWNLOAD_MODULE_HIDDEN = true
const HIDDEN_VIEWS: ViewId[] = ['downloading', 'completed']

const NAV_ITEMS: { id: ViewId; labelKey: string; icon: JSX.Element }[] = [
  {
    id: 'downloading',
    labelKey: 'nav.downloading',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
  },
  {
    id: 'completed',
    labelKey: 'nav.completed',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'media',
    labelKey: 'nav.media',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    ),
  },
  {
    id: 'tg',
    labelKey: 'nav.tg',
    icon: (
      <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
]

const FolderIcon = (
  <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75A2.25 2.25 0 014.5 4.5h3.879a2.25 2.25 0 011.59.659l1.171 1.171a2.25 2.25 0 001.59.659H19.5a2.25 2.25 0 012.25 2.25v8.25A2.25 2.25 0 0119.5 19.5H4.5A2.25 2.25 0 012.25 17.25V6.75z" />
  </svg>
)

const ChevronIcon = (
  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
  </svg>
)

export function Sidebar({
  view,
  onViewChange,
  categories,
  categoryFilter,
  onCategoryChange,
  collapsed,
  onToggle,
  counts,
  tgBound,
  tgReady,
}: Props) {
  const { t } = useTranslation()
  const [catOpen, setCatOpen] = useState(false)
  const allActive = view === 'all' && categoryFilter === null

  /** 点击「全部文件」文字/图标：仅切到全部视图（方案1：不碰子菜单展开态，纯导航动作） */
  const handleSelectAll = () => {
    onCategoryChange(null)
    onViewChange('all')
  }
  /** 点击 chevron：仅翻转子菜单展开/收起，不改变当前视图与筛选 */
  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCatOpen((o) => !o)
  }

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border-subtle bg-surface transition-all duration-300 ease-out',
        collapsed ? 'w-12' : 'w-48',
      )}
    >
      {/* Logo + 折叠/展开 */}
      <div
        className={cn(
          'flex h-12 items-center gap-2 px-3',
          collapsed ? 'justify-center' : 'justify-between',
        )}
      >
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

      {/* 折叠态：独立展开按钮 */}
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

      {/* 导航 */}
      <nav className="flex-1 space-y-1 px-2">
        {/* 全部文件：chevron 与文字/图标为两个独立点击动作 */}
        <div>
          {collapsed ? (
            <button
              onClick={handleSelectAll}
              title={t('nav.all')}
              aria-label={t('nav.all')}
              className={cn(
                'flex h-9 w-full items-center justify-center rounded-md text-sm transition-all duration-200',
                allActive
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
              )}
            >
              {FolderIcon}
            </button>
          ) : (
            /*
             * 「全部文件」= **一个视觉单元、两个独立动作**。
             *
             * 容器承担 hover/选中底色与左右留白，metrics 与同列导航行完全一致
             * （`px-2.5 py-2` + `gap-2.5`）—— 于是 folder 图标左缘、计数徽标右缘
             * 与下方 媒体库/TG/设置 三行严格对齐（此前内层按钮额外 `px-1 py-1`，
             * 图标被推到 14px 而兄弟行是 10px，这就是「留白不一致」）。
             *
             * 文字区只切视图、chevron 只翻转子菜单，两者状态**仍完全解耦**
             * （曾因混入 setCatOpen 变成杂交体）；但底色只画在容器上，hover 靠 CSS
             * `:hover` 冒泡覆盖整行 —— 不再是两块各自发亮的独立按钮（「脱离」）。
             */
            <div
              data-testid="all-files-row"
              className={cn(
                'flex w-full items-center rounded-md px-2.5 py-2 text-sm transition-all duration-200',
                allActive
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
              )}
            >
              <button
                onClick={handleSelectAll}
                title={t('nav.all')}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="shrink-0">{FolderIcon}</span>
                <span className="flex-1 truncate text-left">{t('nav.all')}</span>
                {counts.total > 0 && (
                  <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-soft">
                    {counts.total}
                  </span>
                )}
              </button>
              <button
                onClick={handleToggle}
                title={t('sidebar.toggleCategories')}
                aria-label={t('sidebar.toggleCategories')}
                aria-expanded={catOpen}
                data-testid="category-chevron"
                className="ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-60 transition-all duration-200 hover:opacity-100"
              >
                <span className={cn('transition-transform duration-200', catOpen && 'rotate-90')}>
                  {ChevronIcon}
                </span>
              </button>
            </div>
          )}

          {catOpen && !collapsed && categories.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {categories.map((cat) => {
                const active = view === 'all' && categoryFilter === cat
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      onViewChange('all')
                      onCategoryChange(cat)
                    }}
                    title={cat}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md py-1.5 pl-9 pr-2.5 text-[13px] transition-colors',
                      active
                        ? 'bg-accent/15 text-accent'
                        : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
                    )}
                  >
                    <span className="flex-1 truncate text-left">{t(`category.${cat}`, undefined, cat)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {NAV_ITEMS.filter(
          (item) =>
            (!DOWNLOAD_MODULE_HIDDEN || !HIDDEN_VIEWS.includes(item.id)) &&
            (item.id !== 'tg' || (tgBound && tgReady)),
        ).map((item) => {
          const active = view === item.id
          const count =
            item.id === 'downloading'
              ? counts.active
              : item.id === 'completed'
                ? counts.completed
                : 0
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              title={t(item.labelKey)}
              data-testid={`nav-${item.id}`}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-all duration-200',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-soft hover:bg-surface-2 hover:text-fg-mid',
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">{t(item.labelKey)}</span>
                  {count > 0 && (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-soft">
                      {count}
                    </span>
                  )}
                </>
              )}
            </button>
          )
        })}
      </nav>

      {/* 底部状态 */}
      <div className={cn('border-t border-border-subtle p-3', collapsed && 'p-2')}>
        <div className={cn('flex items-center gap-2', collapsed && 'justify-center')}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
          {!collapsed && <span className="text-[11px] text-muted">{t('status.daemonRunning')}</span>}
        </div>
      </div>
    </aside>
  )
}
