/**
 * 回溯进度的**按天切片**（BUG-457）。
 *
 * 引擎侧 `TgMonitoredChannel` 目前只有 `backfillUntil`（目标日）与
 * `backfillBeforeId`（消息号游标）—— 消息号对用户没有日历意义，界面因此
 * 说不出「已回溯 X 天 / 共 Y 天」，用户点了「回溯到 1 月」只看到一条脉冲条，
 * 等同于「没反应」。
 *
 * 本模块用**已有字段**换算天粒度，不新增引擎端点、不改 schema：
 *   - `totalDays` = 今天 − 目标日（服务端 `parse_date_utc` 同口径：UTC 日界）；
 *   - `doneDays`  = 今天 − `oldestMessageDate`（库内最老已入库日期；回溯向旧翻，
 *     它每推进一页就往旧走，是单调、可核对的真进度）；夹到 `[0, totalDays]`，
 *     防止「回溯开始前库里已有更早数据」把进度算成 120%；
 *   - `reading`   = 还有待回溯天数 ⇒ 后台仍在翻页（「读取进度」的实时态）。
 *
 * 刻意**不做百分比分母猜测**（起点日后端没存），也刻意不引入定时器：
 * 进度由面板既有的监控列表刷新带入，不新增轮询（BUG-095 的周期自检禁令同源）。
 */
export interface BackfillDays {
  /** 目标日距今天的总天数（0 = 无待回溯） */
  totalDays: number
  /** 已回溯天数（按库内最老已入库消息日期换算） */
  doneDays: number
  /** 是否仍在读取/翻页（还有待回溯天数） */
  reading: boolean
  /** 是否已完成（total > 0 且 done >= total） */
  done: boolean
}

const DAY = 86_400

/** unix 秒 → UTC 日序号（与服务端 `parse_date_utc` 的 UTC 日界一致） */
function utcDayIndex(unixSec: number): number {
  return Math.floor(unixSec / DAY)
}

export function backfillDays(input: {
  /** 目标日期（unix 秒；0/缺省 = 没有待回溯） */
  backfillUntil?: number
  /** 库内最老已入库消息日期（unix 秒；0/缺省 = 还没有入库数据） */
  oldestMessageDate?: number
  /** 当前时间（测试可注入；缺省 = Date.now()） */
  now?: number
}): BackfillDays {
  const now = input.now ?? Date.now()
  const today = utcDayIndex(Math.floor(now / 1000))
  const until = input.backfillUntil ?? 0
  if (until <= 0) return { totalDays: 0, doneDays: 0, reading: false, done: false }
  const totalDays = Math.max(0, today - utcDayIndex(until))
  const oldest = input.oldestMessageDate ?? 0
  const rawDone = oldest > 0 ? today - utcDayIndex(oldest) : 0
  const doneDays = Math.min(totalDays, Math.max(0, rawDone))
  return {
    totalDays,
    doneDays,
    reading: totalDays > 0 && doneDays < totalDays,
    done: totalDays > 0 && doneDays >= totalDays,
  }
}
