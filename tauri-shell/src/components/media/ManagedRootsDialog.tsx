import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { DirectoryPicker } from '../DirectoryPicker'
import { addManagedRoot, listManagedRoots, removeManagedRoot, setPrimaryManagedRoot } from '../../api/tg'
import type { ManagedRoot } from '../../api/tg'
import { importMediaItems, scanDirectory } from '../../api/media'
import { displayPath } from '../../lib/pathDisplay'
import { useTranslation } from '../../i18n'

/**
 * BUG-458：文件管理主操作从「导入目录（扫描 → 勾选 → 写库）」改为「**目录管理**」。
 *
 * 根因：原主操作是**一次性**链路 —— 目录只是扫描的输入参数，用完即弃；关闭对话框后
 * 目录里新增的文件不会被看到，「导入」这个名字承诺的「持续纳管」并不存在。
 *
 * 这里落的是「受管根集合」的管理：登记 / 移除 / 设为主目录 / **手动对账**。
 * 全部复用既有引擎端点（`/api/fs/roots*`，零引擎改动）：
 *   - 登记 = 该目录成为纳管对象；
 *   - 对账（裁定 B 时点 2「用户显式点击」）= 扫描各根 + 按**路径幂等**登记条目
 *     （`scanDirectory` → `importMediaItems`），即裁定 A 第 2 支「库没有文件有 ⇒ 建条目」。
 *     只建条目、不自动成剧（成剧是另一条链路）。
 */
export function ManagedRootsDialog(props: {
  onClose: () => void
  /** 对账完成：告知父层本次新增/命中的条目数（父层据此刷新列表） */
  onReconciled: (count: number) => void
  /** 次级入口：仍保留「导入文件（勾选）」链路（不删既有能力） */
  onOpenImport: () => void
  onError: (msg: string) => void
}) {
  const { t, language } = useTranslation()
  const { onClose, onReconciled, onOpenImport, onError } = props
  const zh = language !== 'en-US'
  const [roots, setRoots] = useState<ManagedRoot[]>([])
  const [newRoot, setNewRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listManagedRoots()
        if (alive) setRoots(list)
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const runRoot = async (fn: () => Promise<ManagedRoot[]>) => {
    setBusy(true)
    try {
      setRoots(await fn())
      setLoadErr(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 对账（本面板唯一一次 IO 重活，只在用户点「完成」时跑）：
   * 逐根扫描 + 按路径幂等登记。缩略图/字节不参与，只补条目。
   */
  const reconcileAndClose = async () => {
    setBusy(true)
    try {
      let added = 0
      for (const r of roots) {
        // 下载根（locked）下的字节恒由入库链路登记过，重复扫只会白跑一遍全部文件
        if (r.locked) continue
        const files = await scanDirectory(r.path).catch(() => [])
        if (files.length === 0) continue
        const res = await importMediaItems(
          files.map((f) => ({
            path: f.path,
            source: 'local' as const,
            kind: f.kind,
            size: f.size,
          })),
        )
        added += res.count
      }
      onReconciled(added)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="managed-roots-dialog"
      >
        <header className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <h2 className="text-base font-semibold text-fg-strong">{t('downloads.managedTitle')}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t('downloads.managedHint')}</p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loadErr && <p className="mb-2 text-[11px] text-danger">{loadErr}</p>}
          <ul className="space-y-1.5">
            {roots.map((r) => (
              <li
                key={r.path}
                className="flex flex-wrap items-center gap-2"
                data-testid="dir-manage-root-row"
                data-locked={r.locked ? '1' : '0'}
                data-primary={r.primary ? '1' : '0'}
              >
                <span
                  className="min-w-0 flex-1 truncate rounded-md border border-border-subtle bg-surface-2/40 px-3 py-1.5 font-mono text-xs text-fg-mid"
                  title={displayPath(r.path)}
                >
                  {displayPath(r.path)}
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
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => void runRoot(() => setPrimaryManagedRoot(r.path))}
                    data-testid="dir-manage-set-primary"
                  >
                    {t('downloads.managedSetPrimary')}
                  </Button>
                )}
                {!r.locked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-[11px] text-destructive"
                    disabled={busy}
                    onClick={() => void runRoot(() => removeManagedRoot(r.path))}
                    data-testid="dir-manage-remove"
                  >
                    {t('downloads.managedRemove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-2 flex items-center gap-1.5">
            <div className="min-w-0 flex-1" data-testid="dir-manage-new-picker">
              <DirectoryPicker
                value={newRoot}
                onChange={setNewRoot}
                placeholder={t('downloads.managedAddPlaceholder')}
                onError={onError}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={busy || !newRoot.trim()}
              onClick={() => {
                const p = newRoot.trim()
                if (!p) return
                setNewRoot('')
                void runRoot(() => addManagedRoot(p))
              }}
              data-testid="dir-manage-add"
            >
              {t('downloads.managedAdd')}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            {t('downloads.managedNote')}
          </p>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-subtle/60 px-4 py-2.5">
          {/* 主路径 = 完成（顺带按裁定 B 时点 2 跑一次对账）；次级 = 勾选导入（原链路） */}
          <Button
            size="sm"
            className="h-7 px-3 text-[11px]"
            disabled={busy}
            onClick={() => void reconcileAndClose()}
            data-testid="dir-manage-done"
          >
            {busy ? (zh ? '对账中…' : 'Reconciling…') : zh ? '完成（对账入库）' : 'Done (reconcile)'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-[11px]"
            disabled={busy}
            onClick={onOpenImport}
            data-testid="dir-manage-open-import"
          >
            {t('media.import.title')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-[11px]"
            onClick={onClose}
          >
            {t('media.cancel')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
