import { memo } from 'react'
import { Button } from '../components/ui/button'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'

/**
 * 上下文栏右槽（文件域）：**库级动作组**（BUG-317 四件套①+② / 任务 #9）。
 *
 * 「导入目录 / 新建剧集 / 导出 / 标签管理」是库级动作（不读任何选择集、
 * 任何文件视图恒定可用），按页面结构规范应落在**标题区右槽**：
 *   - 导入目录 = `page-primary-action`（每页唯一主操作，primary 变体）——
 *     用户进文件页最高频的入口就是「把新内容纳管进来」；
 *   - 新建剧集 / 导出 / 标签管理 = 次级（secondary 变体），不与主按钮平铺竞争。
 *
 * **动作实现在 MediaLibraryPanel**（对话框 state、`refreshAll`、数据局部性
 * 都在那里）：面板挂载时把四个 dialog-open handler 注册进 store 的
 * `filesActions`，本组件只读取调用（跨子树信号，同 `pendingMediaFocus`
 * 模式）。`filesActions` 为 null（面板未挂载）时整簇不渲染 ——
 * 不可用就不展示，不呈现死按钮。
 *
 * 选择态动作（全选/全不选/批量打标/加入剧集/删除）**不在这里** ——
 * 它们在 items 视图的浮动底部选择条（`items-selection-bar`），
 * 与剧集墙 `series-selection-bar` 同构（任务 #9 用户裁定「弹出选择模式」）。
 */
export const ContextBarFilesActions = memo(function ContextBarFilesActions() {
  const { t } = useTranslation()
  const filesActions = useStore((s) => s.filesActions)
  if (!filesActions) return null

  return (
    <>
      {/* 主操作（BUG-458）：由「导入目录」改为「目录管理」—— 点击打开的是受管根
          集合的登记/移除/设主/对账，而不是一次性的「扫描 → 勾选 → 写库」。
          文案走 i18n（`media.dirManage`）。 */}
      <Button size="sm" onClick={filesActions.import} data-testid="page-primary-action">
        <svg
          className="mr-1 h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        {t('media.dirManage')}
      </Button>
      {/* 次级：新建剧集（testid 沿用既有契约，验收脚本直接点） */}
      <Button
        size="sm"
        variant="secondary"
        onClick={filesActions.createSeries}
        data-testid="media-new-series"
      >
        <svg
          className="mr-1 h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6.75h8.25M12 12h8.25M12 17.25h8.25M3.75 6.75h.008v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.008v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.008v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
          />
        </svg>
        {t('media.newSeries')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={filesActions.export}
        data-testid="media-export-preview"
      >
        {t('media.export')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={filesActions.manageTags}
        data-testid="media-tag-manage"
      >
        {t('media.manageTags')}
      </Button>
    </>
  )
})
