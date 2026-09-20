/**
 * 接口读缓存：**同一份数据在一次会话里只拉一次**。
 *
 * 起因是用户报的「进入播放页会进行大批量相同请求」：同一部剧集的详情由三个
 * 消费者各拉一遍（剧集墙点开、点播放时扩列表、播放页侧栏），进一次剧集 + 点一次
 * 播放就发 5 次请求（含 React 严格模式下 effect 双调用的 2 次）。请求数在这里不是
 * 「慢」，而是**同一份数据被当成了三份**。
 *
 * 三条规则：
 *   1. **在途合并**：同 key 的并发调用共享同一个 Promise（严格模式双调用也只发一次）；
 *   2. **结果缓存**：同 key 在本次会话内只拉一次，切视图/进播放页直接命中；
 *   3. **显式失效**：任何写操作后由调用方 `invalidateCache()` 作废 —— 缓存**不做时间过期**，
 *      随机过期会让「刚改完又看到旧值」间歇出现，那种问题比多一次请求难查得多。
 *
 * `peek` 给需要**同步**读取的消费者（如 hook 的首屏 state），避免先闪一次 loading。
 */
const inflight = new Map<string, Promise<unknown>>()
const resolved = new Map<string, unknown>()

/** 同步读取已缓存的值；没有则 undefined。 */
export function peek<T>(key: string): T | undefined {
  return resolved.get(key) as T | undefined
}

/** 取数据：命中缓存/在途请求直接返回，否则发起一次。 */
export function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = resolved.get(key)
  if (hit !== undefined) return Promise.resolve(hit as T)
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const p = loader()
    .then((v) => {
      resolved.set(key, v)
      return v
    })
    .catch((e: unknown) => {
      // 失败不留在缓存里：一次网络抖动不该让这个 key 在此后整个会话都用不了。
      inflight.delete(key)
      throw e
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}

/**
 * 作废缓存。不传 prefix 即全部作废（写操作后的默认做法）——
 * 按前缀精细失效看着更「聪明」，但漏掉一处就是「改完没反应」，代价远大于多发一次请求。
 */
export function invalidateCache(prefix?: string) {
  if (!prefix) {
    inflight.clear()
    resolved.clear()
    return
  }
  for (const k of [...resolved.keys()]) if (k.startsWith(prefix)) resolved.delete(k)
}

/** 缓存键：集中在这里，避免各处手写字符串拼错导致「缓存了但永远不命中」。 */
export const cacheKey = {
  /** 剧集列表（按标签筛选时是不同的 key：筛过的与全量不是同一份数据） */
  seriesList: (tagId: number | null) => `series:list:${tagId ?? 'all'}`,
  /** 剧集详情（含分集列表） */
  seriesDetail: (id: number) => `series:detail:${id}`,
}
