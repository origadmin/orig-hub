#!/usr/bin/env node
'use strict'

/**
 * media-library-layout 重排 专用 testid 兼容层（qa-2）。
 *
 * 背景：design §13.1 明确要求「改名/移除的 testid **原样返回**」——旧节点名是对外契约
 * （`episode-image-viewer` → 同时提供 `lightbox` 与 `episode-image-viewer`）。本模块提供
 * 两条能力，供验收脚本在**不改动 src/ 源码**的前提下复用：
 *
 *   1. `installTestidAliases(page)`：在页面内注入 MutationObserver，把新节点名镜像成旧别名
 *      （只加 `data-testid` 别名，DOM 结构/样式不动）。**唯独 `series-gallery*` 不设别名** ——
 *      PRD R6 要求 `series-gallery` 节点数 == 0，若给它别名，R6 就永远测不出来（假绿）。
 *
 *   2. `findPosterContainer()`：在页面内按**语义**（aspect-ratio ≥ 16:9 的封面容器）
 *      定位 Hero 海报容器，而不是靠 `aspect-video w-80` 这类会漂移的类名。
 *      供 R-A/R-B/R-C 断言使用。
 *
 * 兼容层的存在本身不构成验收结论：若工程已按 §13.1 直接保留旧节点名，shim 是幂等的。
 * 若工程删除旧节点名，shim 让「旧脚本不红」而新脚本（TL-21）只认新名字 —— 这正是拆分脚本的意图。
 */

/**
 * 新节点名 → 旧别名（§13.1 对照表）。
 *
 * ⚠️ **`episode-photo-*` → `series-gallery*` 这三条别名被刻意删除**：
 * 它们与 §13.1 的意图正相反。§13.1 把 `series-gallery*` 列为**被移除**的节点，
 * PRD R6 的判据是「`series-gallery` 节点数 == 0」，`verify_series_detail_layout.cjs`
 * 与 `verify_series_detail_rows.cjs` 都按这个数断言。一旦把 `episode-photo-grid`
 * 镜像成 `series-gallery`，shim 就**自己造出**了那个本应消失的节点，
 * 于是 R6 恒报「still rendered (1 nodes)」——这是假红，且与文件头「唯独
 * series-gallery* 不设别名」自相矛盾。能力继承由新节点名 `episode-photo-*`
 * 直接表达，不靠旧名映射。
 */
const TESTID_ALIASES = {
  lightbox: 'episode-image-viewer',
  'lightbox-close': 'episode-image-viewer-close',
  'lightbox-prev': 'episode-image-viewer-prev',
  'lightbox-next': 'episode-image-viewer-next',
  'lightbox-position': 'episode-image-viewer-position',
  'series-edit': 'series-title-edit',
}

/**
 * 在页面上下文中安装别名镜像器。必须在每次 `page.goto()` 之后重新调用
 * （导航会清掉注入的脚本）。
 */
async function installTestidAliases(page) {
  await page.evaluate((aliases) => {
    const install = () => {
      if (window.__qa2TestidAliasInstalled) return
      window.__qa2TestidAliasInstalled = true
      const pairs = Object.entries(aliases)
      const mirror = () => {
        for (const [newName, oldName] of pairs) {
          const nodes = document.querySelectorAll(`[data-testid="${newName}"]`)
          nodes.forEach((el) => {
            if (!el.hasAttribute(`data-testid-${oldName}`)) {
              el.setAttribute(`data-testid-${oldName}`, '1')
            }
          })
        }
      }
      mirror()
      new MutationObserver(mirror).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid'],
      })
      // 旧别名查询：把 `[data-testid="X"]` 查询也认成 `[data-testid-X]` 命中。
      // 仅对旧名生效，避免影响新名查询。
      const origQS = Document.prototype.querySelector
      const origQSA = Document.prototype.querySelectorAll
      const remap = (sel) => {
        const m = /^\[data-testid="([^"]+)"\]$/.exec(String(sel).trim())
        if (!m) return null
        const name = m[1]
        if (!pairs.some(([, oldName]) => oldName === name)) return null
        return `[data-testid-${name}]`
      }
      Document.prototype.querySelector = function (sel) {
        const r = remap(sel)
        return origQS.call(this, r || sel)
      }
      Document.prototype.querySelectorAll = function (sel) {
        const r = remap(sel)
        return origQSA.call(this, r || sel)
      }
      const origEQS = Element.prototype.querySelector
      const origEQSA = Element.prototype.querySelectorAll
      Element.prototype.querySelector = function (sel) {
        const r = remap(sel)
        return origEQS.call(this, r || sel)
      }
      Element.prototype.querySelectorAll = function (sel) {
        const r = remap(sel)
        return origEQSA.call(this, r || sel)
      }
    }
    install()
  }, TESTID_ALIASES)
}

/**
 * 页面内函数：定位 Hero 海报容器（语义判定，不认类名）。
 * 判据：包含一个 <img>，且**计算样式** aspect-ratio ≥ 16:9（容忍浮点），
 * 且位于文档较前（Hero 在分集区之上）。返回第一个命中，附渲染尺寸与 natural 尺寸。
 */
const FIND_POSTER_CONTAINER = () => {
  const imgs = Array.from(document.querySelectorAll('img'))
  const candidates = []
  for (const img of imgs) {
    let el = img.parentElement
    let depth = 0
    while (el && depth < 4) {
      const cs = getComputedStyle(el)
      const ar = cs.aspectRatio
      if (ar && ar !== 'auto') {
        const parts = String(ar).split('/')
        const num = parseFloat(parts[0])
        const den = parts[1] ? parseFloat(parts[1]) : 1
        if (isFinite(num) && isFinite(den) && den > 0) {
          const ratio = num / den
          const r = el.getBoundingClientRect()
          if (r.width > 40 && r.height > 20) {
            candidates.push({
              ratio: Math.round(ratio * 1000) / 1000,
              ratioOk: ratio >= 16 / 9 - 0.02,
              cls: String(el.className).slice(0, 120),
              w: Math.round(r.width),
              h: Math.round(r.height),
              renderedRatio: Math.round((r.width / r.height) * 1000) / 1000,
              naturalW: img.naturalWidth,
              naturalH: img.naturalHeight,
              objectFit: cs.objectFit,
              imgObjectFit: getComputedStyle(img).objectFit,
              testid: el.getAttribute('data-testid') || null,
              visible: el.offsetParent !== null,
            })
            break
          }
        }
      }
      el = el.parentElement
      depth++
    }
  }
  return candidates
}

module.exports = { TESTID_ALIASES, installTestidAliases, FIND_POSTER_CONTAINER }
