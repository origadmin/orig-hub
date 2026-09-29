/**
 * 上下文栏（BUG-083）的**窄订阅选择器**：只返回标量 / 字符串。
 *
 * 为什么必须是标量：zustand v5 用 `Object.is` 比较选择器结果，返回对象或数组字面量
 * 每次都会判定「变了」→ 无限重渲染（AGENTS.md §5 流畅优先）。这里每个选择器都返回
 * `number` / `boolean` / `string`，于是：
 *   - 聚合速度走 `selectActiveSpeedLabel`（**文案**而非字节数）：速度抖动但显示值未变时
 *     `Object.is` 命中，叶子不重渲染（等值短路）；
 *   - 进行中数量走 `selectActiveCount`：只有个数真的变了才重渲染。
 *
 * 不新增任何 store 字段：连接态取 `connected`（SSE onOpen/onClose 维护），
 * daemon 进程态取 `daemon.alive`（启动拉起时写一次，非实时，仅作降级判据），
 * 聚合速度与进行中数量是 `downloads` 的派生量（原先散落在 MainLayout 里现算）。
 */
import { formatSpeed } from '../lib/utils'
import { useStore } from './useStore'

/** `DownloadState` 未导出，用 `getState` 反推根状态类型（不修改 useStore.ts） */
export type RootState = ReturnType<typeof useStore.getState>

type Download = RootState['downloads'][number]

/** 进行中 = 下载中 或 排队中（与 MainLayout 的 `active` 口径一致） */
function isActive(d: Download): boolean {
  return d.status === 'downloading' || d.status === 'queued'
}

/**
 * 进行中任务数（**下载队列口径**）。
 * TG 缓存任务是 TgPanel 的面板内 state，不在 store 里，因此不计入 —— UI 上用
 * `ctx.activeHint` 的 tooltip 标明来源，避免被误读成「TG 缓存任务」。
 */
export const selectActiveCount = (s: RootState): number =>
  s.downloads.reduce((n: number, d: Download) => (isActive(d) ? n + 1 : n), 0)

/** 聚合速度（字节/秒）：所有进行中任务的 speed 之和 */
export const selectActiveSpeedBytes = (s: RootState): number =>
  s.downloads.reduce(
    (sum: number, d: Download) => (isActive(d) ? sum + (d.speed || 0) : sum),
    0,
  )

/** 是否有正在传输的任务（速度区显隐开关；布尔几乎不变 → 长期短路） */
export const selectHasActiveSpeed = (s: RootState): boolean =>
  selectActiveSpeedBytes(s) > 0

/**
 * 速度的**显示文案**（不是数字）：订阅字符串而非字节数，
 * 于是 1.02 MB/s → 1.03 MB/s 之外的抖动不会穿透到组件。
 */
export const selectActiveSpeedLabel = (s: RootState): string =>
  formatSpeed(selectActiveSpeedBytes(s))

/** 是否存在已暂停任务（「全部开始」的 disabled 依据） */
export const selectHasPaused = (s: RootState): boolean =>
  s.downloads.some((d: Download) => d.status === 'paused')

/**
 * 是否存在可清空任务（completed | error | cancelled）——「清空」的 disabled 依据。
 *
 * 与 `useStore.clearCompleted` 的扫描口径严格一致（BUG-082）：失败页也挂「清空」，
 * 若只用「是否存在 completed」判 disabled，则在「只有失败任务」时按钮恒灰 ——
 * 那就又造出一个「按钮有、动作不可达」的死按钮。返回布尔 → 仅在有/无之间翻转。
 */
export const selectHasClearable = (s: RootState): boolean =>
  s.downloads.some(
    (d: Download) =>
      d.status === 'completed' || d.status === 'error' || d.status === 'cancelled',
  )

/** SSE 实时链路是否连通（低频：仅在断线/重连时翻转） */
export const selectConnected = (s: RootState): boolean => s.connected

/** daemon 进程是否存活（启动时写一次，非实时；只作三态灯的降级判据） */
export const selectDaemonAlive = (s: RootState): boolean => s.daemon?.alive === true

/**
 * TG 入口级门控的**单一判据**（BUG-094 / BUG-097 / BUG-177 / BUG-178）。
 *
 * 设计（2026-09-29 拍板）：**「TG 服务可用？否 → 不显示 TG」**。这里的「服务」
 * 是 **orig-tg 进程**，由 daemon 独占托管 —— 判据因此只问 daemon：
 *
 *   - `enabled && running` → 显示。
 *   - 其余一切 → 不显示。留一个「已开启但未连接」的入口，等于把 daemon 的失职
 *     包装成一种合法的产品状态，用户只会反复怀疑「是不是数据丢了」（BUG-177）。
 *
 * **链路层（Telegram 侧）不参与门控**（BUG-178）：没配凭证、没登录都是**待用户完成的
 * 动作**，藏掉入口就永远完不成。以前判据里掺了链路探测，于是同一时刻出现
 * 「设置页：插件运行中」与「面板：Telegram 不可用」并存 —— 两个真源各说各话。
 *
 * 自救路径在**设置页**（TG 卡片常驻可见），失败原因由 daemon 的 `tg_last_error`
 * 摆在开关旁；拉起/重启/kill 全部由 daemon 执行，不留手动运维入口。
 */
export function resolveTgFeatureReady(tgService: RootState['tgService']): boolean {
  return tgService.enabled && tgService.running
}
