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
 *   ② 真头像走后端 `/api/tg/avatar/:chat_id`。本组件是**唯一**渲染点，
 *      三个调用点不必各改一遍。
 *
 * ② 的降级纪律：端点未上线 / 该频道无头像 / 链路断了 ⇒ 端点返回 404，
 * `<img>` 的 `onError` 落回①的首字符。**不是**「取不到就空白」：降级路径就是
 * 阶段一的产物，两者共用同一个字符规则，不存在第二套兜底逻辑。
 */

import { useState } from 'react'
import { tgBase } from '../api/tg'

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
  /** 频道 id（真头像的请求 key） */
  id: number
  title: string
  /** 直径档位：`8` = 列表行（h-8），`9` = 详情头（h-9） */
  size?: 8 | 9
}

export function TgAvatar({ id, title, size = 8 }: Props) {
  const initial = channelInitial(title)
  const box = size === 9 ? 'h-9 w-9 text-sm' : 'h-8 w-8 text-xs'
  // 端点尚未上线时每个频道都会 404 一次；`broken` 记下来，之后不再重试，
  // 避免「N 个频道 × 每次渲染」的请求放大（与 thumb 404 同款纪律）。
  const [broken, setBroken] = useState(false)
  const src = broken || !id ? null : `${tgBase()}/api/tg/avatar/${id}`

  return (
    <div
      data-testid="tg-avatar"
      data-channel-id={id}
      data-initial={initial}
      data-src={src ?? ''}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 font-semibold text-fg-mid ${box}`}
    >
      {/* 首字母先渲染在下层：图片加载失败时无需等待状态切换就有内容（不闪空）。 */}
      <span className="absolute inset-0 flex items-center justify-center">{initial}</span>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : null}
    </div>
  )
}
