---
status: active
scope: tauri-shell（前端）
date: 2026-10-23
enforced-by: 共享组件（`components/ui/*`）+ 验收探针几何断言
---

# 样式标准（UI 唯一形态）

> 立项原因（用户 2026-10-23）：「全部下载 的选择又出现了样式不一致情况. 应该和剧集一样.
> 样式就应该统一,应该有一个标准」。
>
> 总则：**同一形态的控件只允许有一处实现**（`tauri-shell/src/components/ui/`）。
> 新增交互形态先问「已有哪个组件是它」，没有就**先建组件再建用法**——
> 在业务文件里手写一串类名 = 制造下一次不一致。

## 1. 共享组件优先（硬性）

| 形态 | 唯一实现 | 覆盖的域 |
|---|---|---|
| 选择条（选中后的浮层） | `ui/selection-bar.tsx::SelectionBar` | 剧集墙(items)、剧集墙(series)、下载域、后续任何批量选择 |
| 全选 / 全不选 | `ui/selection-bar.tsx::SelectAllButtons` | 同上（**成对出现**，禁止只有全选） |
| 行选择框 | `ui/selection-bar.tsx::RowCheckbox` | 下载行、入库行、剧集拆分行、剧集卡片 |
| 按钮 | `ui/button.tsx::Button`（`size="sm"` + `h-7 px-2 text-[11px]`） | 全仓 |
| 弹窗容器 | `ui/*` 既有 dialog 原语 | BUG-321 的 dialog 几何门禁 |

验收脚本依赖的 `data-testid` 是**契约**：换实现必须保留原 testid，禁止顺手改名。

## 2. 选择条（SelectionBar）标准形态

- 位置：**视口**底部居中（`fixed bottom-4 left-1/2 -translate-x-1/2`）。
  ⚠️ 用 `absolute` 写同一串类名**得不到同一落点**——两域的包含块不同
  （实测剧集墙比下载域右偏 96px、上移 32px，BUG-393 S1b）。浮层一律视口相对。
- 容器：`rounded-full border border-accent/40 bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-md`。
- 计数：`text-[11px] font-medium text-fg-strong`（`count=0` 时不渲染，避免空条噪音）。
- 按钮：`size="sm"` + `h-7 px-2 text-[11px]`；主要动作 `outline`、次要 `ghost`、破坏性加 `text-destructive`。
- **模态内嵌批量条**（`CacheManagerDialog` 的 `cache-batch-bar` 等）：在对话框内、`fixed` 会逸出模态，
  故保留 inline（`mt-2`）但**套用同一胶囊/边框/背景形态**，使视觉与全屏视图一致；待后续统一为
  `<SelectionBar fixed={false}>`（相对对话框定位）。

判据（探针 `verify_bug393_selection_standard.cjs`）：两域 bottomGap ≤24px 且相等、
水平中心偏移 ≤4px、按钮高 ≤28px、字号 11px、行选择框 16×16。

## 3. 尺寸与排版基线

| 项 | 标准 |
|---|---|
| 次要按钮（条内/工具条） | `h-7 px-2 text-[11px]` |
| 主要按钮 | `size="default"`，`h-9 px-4 text-[13px] font-semibold` |
| 正文 | `text-[13px]`；次要说明 `text-[12px] text-muted`；微标签 `text-[10px]` |
| 命中区 | 交互元素 ≥36×36（BUG-327）；行内次要动作同样适用 |
| 行选择框 | `h-4 w-4 accent-accent`（**不用** `h-3.5`） |
| 圆角 | 卡片 `rounded-2xl`；行/块 `rounded-lg`；浮层/胶囊 `rounded-full` |

## 4. 状态可见性

1. 禁用态**保留渲染**并 `disabled`（消失比灰着更难找）。
2. 不可用/降级必须**直出原因 + 可行动出口**，禁用「正在启动」「暂无」这类把多状态混成一句的文案（BUG-389）。
3. 作用域受限的计数/列表必须标注作用域（BUG-390）。
4. 主题适配：浅色主题浅底深字、深色主题深底浅字；图表/画布内的硬编码色同样遵守。

## 5. 禁止项

- 禁止在业务组件里内联复制上述形态的类名串（一律引共享组件）。
- 禁止用散点补丁（`-mx-*` 之类）做跨容器出血；用 `.full-bleed` 原语（BUG-321 已永久禁用 `-mx-*`）。
- 禁止 `fixed` 侧栏 + `main marginLeft` 互斥组合（会让内部元素永远到不了视口左边）。
