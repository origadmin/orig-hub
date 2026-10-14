import { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  listOrganizePresets,
  organizeApply,
  organizePreview,
  type OrganizePreset,
  type OrganizeReport,
} from '../../api/media'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { DirectoryPicker } from '../DirectoryPicker'
import { isTauri } from '../../lib/env'

/**
 * **批量整理向导**（mp3tag 式模板命名 / 归位）—— D24-A / BUG-311。
 *
 * ## 流程（四步，顺序不可换）
 *
 * 1. 选条目（由文件域多选带进来，本组件不再自己列库）；
 * 2. 选模板（预设下拉 + 可手改）；
 * 3. 选产物根目录（`DirectoryPicker`）；
 * 4. **预览全表 diff** → 执行。
 *
 * ## 为什么预览是**单独一步**而非「点了就整」
 *
 * 模板是用户输入的自由文本，渲染结果可能撞名、可能把 `..` 折成 `_`、可能碰上
 * 磁盘已存在的同名文件。预览把这几件事**在执行前摊开给用户看**（`note` 逐条说明），
 * 否则用户按一个按钮得到一堆意料之外的 `(2)` 文件，还没法回溯。
 *
 * ## 安全边界（09 §15.2 红线）
 *
 * - 整理**绝不**修改 blob 或 `media_item.file_path`（播放永远走 blob）；
 * - 执行**幂等**：已就位 ⇒ `skip`，可反复重跑；
 * - 同名**加序号**，绝不静默覆盖；
 * - 产物不是唯一字节来源 —— 外部删了不影响库内播放。
 * 这些都由引擎夹具锁死（`organize::tests`），本组件只负责如实展示。
 */
export function OrganizeWizard(props: {
  /** 待整理的条目 id（来自文件域多选）。 */
  itemIds: number[]
  onClose: () => void
  onError: (msg: string) => void
}) {
  const { itemIds, onClose, onError } = props
  const { t } = useTranslation()
  const [presets, setPresets] = useState<OrganizePreset[]>([])
  const [template, setTemplate] = useState('{剧名}/S{season:02}E{episode:02} - {集名}.{ext}')
  const [targetDir, setTargetDir] = useState('')
  const [preview, setPreview] = useState<OrganizeReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<OrganizeReport | null>(null)

  useEffect(() => {
    void listOrganizePresets()
      .then((p) => setPresets(p))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
    // 只在挂载时取一次预设（预设是静态清单，不该随每次输入重取）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = useMemo(() => result?.rows ?? preview?.rows ?? [], [result, preview])
  const summary = result?.summary ?? preview?.summary

  const canPreview = itemIds.length > 0 && template.trim().length > 0 && !busy
  const actionable = (summary?.total ?? 0) - (summary?.missing ?? 0) - (summary?.blocked ?? 0)

  const runPreview = async () => {
    setBusy(true)
    try {
      setResult(null)
      setPreview(await organizePreview(itemIds, template.trim(), targetDir.trim()))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runApply = async () => {
    setApplying(true)
    try {
      const r = await organizeApply(itemIds, template.trim(), targetDir.trim())
      setResult(r)
      setPreview(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  /** 动作徽标：颜色即语义（绿=新写、灰=幂等跳过、红=阻断、蓝=跨卷副本）。 */
  const actionStyle: Record<string, string> = {
    link: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600',
    copy: 'border-sky-500/40 bg-sky-500/10 text-sky-600',
    skip: 'border-border-subtle bg-surface-2 text-muted',
    missing: 'border-amber-500/40 bg-amber-500/10 text-amber-600',
    blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border-subtle bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="organize-wizard"
      >
        <h4 className="border-b border-border-subtle/60 px-4 py-3 text-[13px] font-semibold text-fg-strong">
          {t('media.organize.title', { n: itemIds.length })}
        </h4>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {/* ① 模板 */}
          <div>
            <label className="block text-[11px] text-muted" htmlFor="organize-template">
              {t('media.organize.template')}
            </label>
            <Input
              id="organize-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="mt-1 h-8 text-xs"
              data-testid="organize-template"
            />
            {presets.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    title={p.template}
                    onClick={() => setTemplate(p.template)}
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                      template === p.template
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border-subtle text-muted hover:bg-surface-2',
                    )}
                    data-testid={`organize-preset-${p.id}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ) : null}
            {/* 变量说明：模板是自由文本，用户需要知道有哪些可用变量 —— 这不是
                「能力边界提示」，而是输入框的合法取值说明。 */}
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              {t('media.organize.varsHint')}
            </p>
          </div>

          {/* ② 产物根目录 */}
          <div>
            <label className="block text-[11px] text-muted" htmlFor="organize-target">
              {t('media.organize.targetDir')}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id="organize-target"
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                placeholder={t('media.organize.targetPlaceholder')}
                className="h-8 min-w-0 flex-1 text-xs"
                data-testid="organize-target"
              />
              {isTauri() ? (
                <DirectoryPicker value={targetDir} onChange={setTargetDir} />
              ) : null}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted/80">
              {t('media.organize.targetHint')}
            </p>
          </div>

          {/* ③ 汇总 + 预览全表 */}
          {summary ? (
            <div className="space-y-2" data-testid="organize-summary">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-muted">{t('media.organize.summary')}</span>
                {(['link', 'copy', 'skip', 'missing', 'blocked'] as const).map((k) => (
                  <span
                    key={k}
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] tabular-nums',
                      (summary[k] ?? 0) > 0 ? actionStyle[k] : 'border-transparent text-muted/50',
                    )}
                    data-testid={`organize-sum-${k}`}
                  >
                    {t(`media.organize.action.${k}`)} {summary[k] ?? 0}
                  </span>
                ))}
                {result ? (
                  <span className="text-emerald-600 tabular-nums" data-testid="organize-written">
                    {t('media.organize.written', { n: result.summary.written })}
                  </span>
                ) : null}
              </div>

              <ul className="divide-y divide-border-subtle/40 rounded border border-border-subtle/60">
                {rows.map((r) => (
                  <li key={r.itemId} className="flex items-start gap-2 px-2 py-1.5 text-[11px]">
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded border px-1 py-px text-[9.5px]',
                        actionStyle[r.action] ?? actionStyle.blocked,
                      )}
                      data-testid={`organize-row-action-${r.itemId}`}
                    >
                      {t(`media.organize.action.${r.action}`)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fg-strong" title={r.targetPath}>
                        {r.targetPath}
                      </span>
                      {r.note ? (
                        <span className="block truncate text-[10px] text-muted" title={r.note}>
                          {r.note}
                        </span>
                      ) : null}
                      {r.conflict ? (
                        <span
                          className="block text-[10px] text-amber-600"
                          data-testid={`organize-conflict-${r.itemId}`}
                        >
                          {t('media.organize.conflict')}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border-subtle/60 px-4 py-3">
          <span className="text-[10px] text-muted/80">{t('media.organize.safeHint')}</span>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
              {t('media.cancel')}
            </Button>
            {result ? (
              <Button size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
                {t('media.done')}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  disabled={!canPreview}
                  onClick={() => void runPreview()}
                  data-testid="organize-preview"
                >
                  {busy ? t('media.item.saving') : t('media.organize.preview')}
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-3 text-xs"
                  disabled={!preview || actionable <= 0 || applying}
                  onClick={() => void runApply()}
                  data-testid="organize-apply"
                >
                  {applying ? t('media.item.saving') : t('media.organize.apply')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
