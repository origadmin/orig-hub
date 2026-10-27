/**
 * 频道头像（BUG-454）。
 *
 * 现状：后端 `GET /api/tg/dialogs` 不返回头像字节，界面只能拿标题首字符兜底。
 * 兜底本身的缺陷是**取字符的方式**：`(title || '?').charAt(0)` 直接取第一个码位，
 * 而 TG 频道标题常以装饰符号开头（实测「【…」），于是头像渲染成一个纯装饰的
 * 「【」—— 用户看到的是「ICON 不对」，不是「没有头像」。
 *
 * 修法两层：
 *   ① 兜底只取**可辨识字符**（跳过开头的空白/标点/符号），装饰字符不再当头像；
 *   ② 真头像（后端 `/api/tg/avatar/:chat_id` + 枚举时缓存 `InputFileLocation`）
 *      就绪后，本组件是**唯一**需要改的地方（加 `<img>` + onError 回落），
 *      三个调用点不必各改一遍。
 */

/** 取标题里第一个「能当标识」的字符：跳过开头的空白、标点、符号与控制字符。 */
export function channelInitial(title: string): string {
  const raw = (title || '').trim()
  // `\p{P}` 标点 / `\p{S}` 符号 / `\p{C}` 其它（含部分 emoji）——装饰前缀全在这一类。
  // 只剥**开头**的装饰；剥完为空 = 整个标题都是装饰（或空标题）—— 此时兜到 `#`，
  // 绝不退回 raw 的首字符（那正是「【」被当头像的路径）。
  const stripped = raw.replace(/^[\p{P}\p{S}\p{C}\s]+/u, '')
  return (stripped.charAt(0) || '#').toUpperCase()
}

interface Props {
  /** 频道 id（真头像就绪后即请求 key；当前仅用于 testid 稳定定位） */
  id: number
  title: string
  /** 直径档位：`8` = 列表行（h-8），`9` = 详情头（h-9） */
  size?: 8 | 9
}

export function TgAvatar({ id, title, size = 8 }: Props) {
  const initial = channelInitial(title)
  const box = size === 9 ? 'h-9 w-9 text-sm' : 'h-8 w-8 text-xs'
  return (
    <div
      data-testid="tg-avatar"
      data-channel-id={id}
      data-initial={initial}
      className={`flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-semibold text-fg-mid ${box}`}
    >
      {initial}
    </div>
  )
}
