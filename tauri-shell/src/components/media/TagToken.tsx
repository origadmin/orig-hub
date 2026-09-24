/**
 * 标签的唯一展示原语：`#名称`。
 *
 * 为什么必须收敛成一个组件：标签此前在 5 个地方各画一遍彩色胶囊
 * （卡片 / 剧集 Hero / 剧集卡 / 侧栏筛选 / 标签管理），每一处都自己拿
 * 标签自带的色值拼半透明底色 —— 样式一旦要改就得改 5 遍，漏一处就是两套视觉。
 * 现在这 5 处只认这一个组件，改样式只改这里。
 *
 * 刻意**不接受 color / style 参数**：标签不再有颜色语义，视觉上只是一条
 * `#名称` 文本。若将来又要给标签上色，请把讨论放到这个文件的注释里，
 * 而不是给每个调用点开 `style` 口子（那正是本次要拆掉的东西）。
 */
export function TagToken(props: {
  /** 标签名（不含 `#`，`#` 由本组件统一渲染） */
  name: string
  /** 追加类，放在最后 —— 调用点可覆盖尺寸 / 外边距 */
  className?: string
  /** 选中态：实心强调底，用于「已选」的标签 */
  active?: boolean
}) {
  const { name, className = '', active = false } = props
  return (
    <span
      className={[
        'inline-flex max-w-full items-baseline gap-px whitespace-nowrap rounded px-1 text-[10px]',
        active ? 'bg-accent text-white' : 'text-muted',
        className,
      ].join(' ')}
    >
      <span className={active ? 'text-white/70' : 'text-accent/80'}>#</span>
      <span className="truncate">{name}</span>
    </span>
  )
}
