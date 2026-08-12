import type { JSX } from 'react'
import { cn } from '../lib/utils'

export type ViewId = 'downloading' | 'completed' | 'settings'

interface Props {
  view: ViewId
  onViewChange: (v: ViewId) => void
  collapsed: boolean
  onToggle: () => void
  counts: { active: number; completed: number }
}

const NAV_ITEMS: { id: ViewId; label: string; icon: JSX.Element }[] = [
  {
    id: 'downloading',
    label: '下载中',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
  },
  {
    id: 'completed',
    label: '已完成',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: '设置',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
]

export function Sidebar({
  view,
  onViewChange,
  collapsed,
  onToggle,
  counts,
}: Props) {
  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border-subtle bg-surface transition-all duration-300 ease-out',
        collapsed ? 'w-12' : 'w-48',
      )}
    >
      {/* Logo */}
      <div className={cn('flex h-14 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/20">
          <span className="text-sm font-bold text-accent">O</span>
        </div>
        {!collapsed && <span className="text-sm font-semibold text-zinc-100">Orig Hub</span>}
      </div>

      {/* 折叠开关 */}
      <button
        onClick={onToggle}
        className={cn(
          'mx-2 mb-2 flex h-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-zinc-200',
          collapsed ? 'w-8' : 'w-9',
        )}
        title={collapsed ? '展开' : '折叠'}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          {collapsed ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          )}
        </svg>
      </button>

      {/* 导航 */}
      <nav className="flex-1 space-y-1 px-2">
        {NAV_ITEMS.map((item) => {
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
              title={item.label}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-all duration-200',
                collapsed && 'justify-center px-0',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-zinc-400 hover:bg-surface-2 hover:text-zinc-200',
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">{item.label}</span>
                  {count > 0 && (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
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
          {!collapsed && <span className="text-[11px] text-muted">daemon 运行中</span>}
        </div>
      </div>
    </aside>
  )
}
