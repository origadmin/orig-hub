import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * 稳定事件回调（useEvent 模式）：**引用恒定、行为永远取最新闭包**。
 *
 * 流畅度的前提——子组件 `memo` 生效要求 props 引用稳定；用内联箭头
 * `onClick={() => doThing()}` 时每次渲染都是新引用，memo 形同虚设，
 * 于是每秒多次的 SSE progress 会把整条高频路径全部重渲染（卡顿根源）。
 * 子组件改为回传自己的数据（如 `onDownload(item)`）或零参调用，父级用本钩子
 * 提供恒定引用、触发时再取最新状态，杜绝陈旧闭包（AGENTS.md §5）。
 *
 * 原先各组件各写一份（TgPanel 内就有同款实现），这里收敛为**唯一实现**。
 */
export function useEvent<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  }, [fn])
  return useCallback((...args: A): R => ref.current(...args), [])
}
