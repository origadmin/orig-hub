/** 历史下载目录管理（localStorage 持久化，上限 10 条，去重，最近优先） */

const KEY = 'orig-hub.recent-dirs'
const MAX = 10

export function getRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function addRecentDir(dir: string): string[] {
  const d = dir.trim()
  if (!d) return getRecentDirs()
  const list = [d, ...getRecentDirs().filter((x) => x !== d)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore quota errors */
  }
  return list
}

export function removeRecentDir(dir: string): string[] {
  const list = getRecentDirs().filter((x) => x !== dir)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
  return list
}
