/**
 * TG 开关/入口的**单一派生器**（BUG-095 结论第 6 条：合成态由前端单一 resolver 负责）。
 *
 * 为什么需要它：`tgService`（进程层）与 `tgLink`（链路层）是两个正交真源，
 * 组件各自 `enabled && running`、`link.state === 'link_down'` 地拼，等于把派生权
 * 下放到每个调用点 —— BUG-087/093 已经证明「多处各派生必错成不同值」。
 *
 * 呈现口径（BUG-095 结论第 1/2/3 条，用户口径优先）：
 *
 *   | 状态        | 判据                                   | 开关         | Navi     | 重试 |
 *   |-------------|----------------------------------------|--------------|----------|------|
 *   | unavailable | `!known`（连 daemon 都够不到）         | 整体置灰     | 不显示   | 无   |
 *   | stopped     | `known && !enabled`（用户显式关闭）    | 可点         | 不显示   | —    |
 *   | on_error    | `enabled && !running`，或链路 link_down| 可点（可关） | 显示     | 常驻 |
 *   | on_ok       | `enabled && running` 且会话就绪        | 可点         | 显示     | —    |
 *
 * **只有 `unavailable` 置灰**：其余再置灰就成了「坏了修不回来」。
 * 方向级 `canTurnOn/canTurnOff` 只是内部表达：不可用态下两个方向都不开放
 * （服务都没起来，改开关没有意义）。
 *
 * 本模块**不做**探测、不持有状态、不写 store：纯函数入参出参，
 * 与 `connState.ts` 是分层不是合并（它管传输层，这里管能力层）。
 */
import type { RootState } from '../store/selectors'

/** 对内六态收口后的**四态**（界面上只有四档：不可用 / 关 / 开·正常 / 开·异常） */
export type TgUiState = 'unavailable' | 'stopped' | 'on_error' | 'on_ok'

export interface TgSwitchView {
  state: TgUiState
  /** 开关整体置灰（`aria-disabled` / `disabled`） */
  disabled: boolean
  /** 侧栏入口是否显示（关闭与不可用都不显示；区别在设置页的原因与出口） */
  navVisible: boolean
  /** 是否常驻「重试连接」出口（仅开·异常态） */
  showRetry: boolean
  /** 内部方向级表达（未在不可用态开放任何方向） */
  canTurnOn: boolean
  canTurnOff: boolean
}

export function resolveTgSwitch(input: {
  tgService: RootState['tgService']
  tgLinkState: RootState['tgLink']['state']
}): TgSwitchView {
  const { tgService, tgLinkState } = input
  // 不可用 = 配置都取不到（daemon 不可达 / 未加载）。此时改开关没有任何意义。
  if (!tgService.known) {
    return {
      state: 'unavailable',
      disabled: true,
      navVisible: false,
      showRetry: false,
      canTurnOn: false,
      canTurnOff: false,
    }
  }
  if (!tgService.enabled) {
    return {
      state: 'stopped',
      disabled: false,
      navVisible: false,
      showRetry: false,
      canTurnOn: true,
      canTurnOff: false,
    }
  }
  // 开着但进程没起来，或进程在而链路断：都是「我改了但没通」——必须保留关闭能力
  // 并常驻重试出口（BUG-095：重试入口常驻是「坏了要能修回来」的唯一保证）。
  if (!tgService.running || tgLinkState === 'link_down') {
    return {
      state: 'on_error',
      disabled: false,
      navVisible: true,
      showRetry: true,
      canTurnOn: false,
      canTurnOff: true,
    }
  }
  return {
    state: 'on_ok',
    disabled: false,
    navVisible: true,
    showRetry: false,
    canTurnOn: false,
    canTurnOff: true,
  }
}
