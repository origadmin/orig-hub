/**
 * 标题清理的**唯一**实现（BUG-264 / D2 全套）。
 *
 * 存量实测 156/373 条目标题带装饰（`🌟🔥🔥《某剧名》 EP2 原档 内群抢先更新 连载中 ⭐⭐⭐`
 * 这种），三个编辑入口此前只做 `trim()`。用户裁定 D1-a：编辑面板给一个「自动清理」
 * 按钮，清理结果**填回输入框**（可预览、可手改、可放弃），而不是保存时静默改写。
 *
 * ## 该剥（6 类，均实测有命中）
 * 1. 频道 emoji 装饰（头部/尾部）
 * 2. `#话题标签`
 * 3. 包裹用 `《》` / `【】` —— **剥括号、留内容**，且可嵌套多轮
 * 4. 集号 `EP8` / `第2集` / `S01E02`
 * 5. 推广语（`新剧首更` / `连载中` / `内群` / `原档` / `完整剧集` / `无二次水印` …）
 * 6. 下载器内部名后缀 `--<chatid>-<msgid>`（BUG-154 只堵了前缀形，后缀形 25 条漏网）
 *
 * ## 不该剥（2 类保护）
 * - 语义性 emoji（`❗️` 这类警示）：只在**首尾**剥，出现在标题中间一律保留
 * - 剥完为空（实测 1 条 `😃`）：**回退为原值**，绝不写空 —— 空标题比脏标题更糟，
 *   它在列表里是不可辨识条目（BUG-240 的成因之一）
 *
 * 单点在渲染无关的 `lib` 层：编辑面板与将来的批量清理入口都调它，不得另写一套。
 */

/** 推广语短语：整词剥除（前后可能有分隔符）。 */
const PROMO = [
  '新剧首更', '抢先更新', '完整剧集', '连载中', '无二次水印', '内群', '原档',
  '首更', '内测', '完整版', '高清版', '未删减', '持续更新', '每日更新',
]

/** 只剥首尾的「装饰」字符：emoji / 符号 / 分隔符 / 括号残片。 */
const EDGE_JUNK = /^[\s\p{Extended_Pictographic}\p{So}\p{Sk}\-—_·|,，。:：;；+~*"'“”‘’!！?？]+|[\s\p{Extended_Pictographic}\p{So}\p{Sk}\-—_·|,，。:：;；+~*"'“”‘’!！?？]+$/gu

function stripEdgeJunk(s: string): string {
  let prev = ''
  let cur = s
  // 反复剥：`🌟🔥 《X》 🔥🌟` 剥掉头尾 emoji 后会露出新的空白/括号残片。
  while (cur !== prev) {
    prev = cur
    cur = cur.replace(EDGE_JUNK, '')
  }
  return cur
}

function unwrapBrackets(s: string): string {
  let prev = ''
  let cur = s
  while (cur !== prev) {
    prev = cur
    cur = cur
      .replace(/《([^《》]*)》/g, '$1')
      .replace(/【([^【】]*)】/g, '$1')
      .replace(/\[([^[\]]*)\]/g, '$1')
  }
  return cur
}

/** 下载器内部名后缀：`--<chat>-<msg>`、`--<chat>_<msg>`，以及其后的任何残留。 */
function stripDownloaderSuffix(s: string): string {
  return s
    .replace(/\s*--[A-Za-z0-9_]+\s*[-_]\s*\d+.*$/u, '')
    .replace(/\s*--\d+\s*[-_]\s*\d+.*$/u, '')
}

function stripEpisodeMarkers(s: string): string {
  return s
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, ' ')
    .replace(/\bEP?\s*\d{1,3}(\s*[-~～]\s*\d{1,3})?\b/gi, ' ')
    .replace(/第\s*\d{1,3}\s*[-~～]?\s*\d{0,3}\s*[集话期]/gu, ' ')
}

function stripPromo(s: string): string {
  let out = s
  for (const p of PROMO) out = out.split(p).join(' ')
  return out
}

/** `_` 只在**紧邻中日韩字符**时当分隔符：`第2集_AI成人短剧` 该分开，
 * 而 `DiagCard_1730000000` 这种标识符里的下划线是名字的一部分，拆开即改名。 */
const CJK = '[\u3400-\u9fff\u3040-\u30ff]'
const UNDERSCORE_BETWEEN_CJK = new RegExp(`(?<=${CJK})_+|_+(?=${CJK})`, 'gu')

/** 把任意分隔符/空白折成单个空格，并去掉两侧残留。 */
function tidy(s: string): string {
  return s
    .replace(UNDERSCORE_BETWEEN_CJK, ' ')
    // 集号被剥掉后会留下「悬空的」下划线（`某剧名 _AI成人短剧`）：行首或空白后的
    // 连续下划线不再是分隔符，直接丢弃。
    .replace(/(^|\s)_+/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-—·|,，。:：;；]+|[\s\-—·|,，。:：;；]+$/gu, '')
    .trim()
}

export interface CleanTitleResult {
  /** 清理后的标题。**永不为空串**：剥空时原样返回输入（判据 2）。 */
  text: string
  /** 是否与输入不同（供 UI 决定按钮是否需要高亮/提示） */
  changed: boolean
  /** 是否发生了「剥完为空 ⇒ 回退原值」（UI 可据此时提示用户「这条需要手工命名」） */
  fellBack: boolean
}

/**
 * 清理一条标题。纯函数：无 i18n、无 IO、无状态，同一输入永远同一输出。
 *
 * @param raw 原标题（可含首尾空白）
 */
export function cleanTitle(raw: string): CleanTitleResult {
  const original = (raw ?? '').trim()
  if (!original) return { text: '', changed: false, fellBack: false }

  let s = stripDownloaderSuffix(original)
  // `#《某剧名》` 这种「话题标签包着书名号」的形态：先只摘 `#`，让后面的 unwrap 把
  // 书名号剥掉留下内容；若直接按 `#token` 整段删，会把标题本身删空（实测 series 221）。
  s = s.replace(/#(?=\s*[《【])/g, ' ')
  s = s.replace(/#[^\s#]+/g, ' ') // 其余话题标签整段剥除
  s = unwrapBrackets(s)
  s = stripEpisodeMarkers(s)
  s = stripPromo(s)
  s = tidy(s)
  s = stripEdgeJunk(s)

  if (!s) return { text: original, changed: false, fellBack: true }
  return { text: s, changed: s !== original, fellBack: false }
}
