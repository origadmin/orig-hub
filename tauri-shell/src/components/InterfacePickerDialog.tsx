import { useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { listInterfaces } from '../api/daemon'
import type { NetworkInterface } from '../types'

export interface InterfaceSelection {
  /** 主网卡名（undefined = 自动识别） */
  primary?: string
  /** 参与分流的附属网卡名（主网卡不在内，始终参与） */
  enabledNames: string[]
}

interface Props {
  open: boolean
  onClose: () => void
  /** 当前已选 */
  selected: InterfaceSelection
  onConfirm: (sel: InterfaceSelection) => void
}

/**
 * 多网卡选择弹窗（纯选择，无任何权重配置）：
 * - 顶部「主网卡」下拉：唯一指定（默认自动识别默认路由网卡）
 * - 下方网卡列表：勾选参与分流的网卡（可多选；主网卡固定勾选禁用）
 * - 未连接 / 虚拟网卡禁用并标注；名称单行省略不换行
 */
export function InterfacePickerDialog({ open, onClose, selected, onConfirm }: Props) {
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [primary, setPrimary] = useState<string | undefined>(selected.primary)
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) return
    listInterfaces()
      .then(({ primary: p, secondaries }) => {
        const all = [p, ...(secondaries ?? [])].filter(Boolean)
        setIfaces(all)
        // 主网卡：沿用上次选择；无则自动识别
        const autoPrimary = p?.name
        const curPrimary =
          selected.primary && all.some((i) => i.name === selected.primary)
            ? selected.primary
            : autoPrimary
        setPrimary(curPrimary)
        // 勾选态：主网卡始终开；附属按上次选择
        const ck: Record<string, boolean> = {}
        for (const nic of all) {
          ck[nic.name] = nic.name === curPrimary || selected.enabledNames.includes(nic.name)
        }
        setChecked(ck)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const usable = (nic: NetworkInterface) => nic.connected && !nic.is_virtual

  const connIfaces = useMemo(() => ifaces.filter(usable), [ifaces])

  const toggle = (name: string) => {
    setChecked((c) => ({ ...c, [name]: !c[name] }))
  }

  const handleConfirm = () => {
    const enabledNames = ifaces
      .filter((nic) => nic.name !== primary && usable(nic) && checked[nic.name])
      .map((nic) => nic.name)
    onConfirm({ primary, enabledNames })
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg animate-spring rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">选择网卡</h2>
          <Badge variant="secondary">参与加速</Badge>
        </div>

        {/* 主网卡选择 */}
        <div className="mt-4 rounded-md bg-surface-2/60 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-zinc-200">主网卡</span>
              <Badge variant="default" className="text-[9px]">默认</Badge>
            </div>
            <select
              value={primary ?? ''}
              onChange={(e) => {
                const name = e.target.value
                setPrimary(name)
                setChecked((c) => ({ ...c, [name]: true }))
              }}
              className="max-w-[60%] flex-1 truncate rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              <option value="">自动识别（默认路由网卡）</option>
              {connIfaces.map((nic) => (
                <option key={nic.name} value={nic.name}>
                  {nic.name} {nic.is_default ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            主网卡始终参与分流，可在下方列表中切换指定。
          </p>
        </div>

        {/* 网卡列表（多选） */}
        <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {ifaces.length === 0 && (
            <p className="text-xs text-muted">daemon 未连接，无法枚举网卡</p>
          )}
          {ifaces.map((nic) => {
            const u = usable(nic)
            const isPrimary = nic.name === primary
            const isOn = checked[nic.name] ?? isPrimary
            return (
              <div
                key={nic.name}
                className={`rounded-md bg-surface-2/60 px-3 py-2 ${u ? '' : 'opacity-50'}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={isPrimary || !u}
                    onChange={() => toggle(nic.name)}
                    className="h-3.5 w-3.5 shrink-0 accent-accent"
                  />
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      nic.connected ? 'bg-success' : 'bg-muted'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                    {nic.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">
                    {nic.ip ?? '—'}
                  </span>
                  {isPrimary && (
                    <Badge variant="default" className="shrink-0 text-[9px]">主</Badge>
                  )}
                  {nic.is_virtual && (
                    <Badge variant="outline" className="shrink-0 text-[9px]">虚拟</Badge>
                  )}
                  {!nic.connected && (
                    <Badge variant="outline" className="shrink-0 text-[9px] text-danger">未连接</Badge>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          勾选已连接的网卡参与分流（可多选）；主网卡固定参与。权重在设置页「多网卡」中按比例自动分配。
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={handleConfirm}>确定</Button>
        </div>
      </div>
    </div>
  )
}
