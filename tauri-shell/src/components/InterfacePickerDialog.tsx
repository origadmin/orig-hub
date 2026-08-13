import { useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { listInterfaces } from '../api/daemon'
import type { NetworkInterface } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  /** 当前已选（网卡名 → 权重）；主网卡始终参与，不在此列 */
  selected: Record<string, number>
  /** 用户确认后回调（含主网卡在内的完整映射） */
  onConfirm: (selected: Record<string, number>) => void
}

/**
 * 多网卡选择弹窗：勾选参与分流的网卡 + 设定权重。
 * 主网卡固定参与不可取消；未连接/虚拟网卡禁用。
 * 供设置页（全局默认）与新建下载弹窗复用。
 */
export function InterfacePickerDialog({ open, onClose, selected, onConfirm }: Props) {
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [weights, setWeights] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    listInterfaces()
      .then(({ primary, secondaries }) => {
        const all = [primary, ...(secondaries ?? [])].filter(Boolean)
        setIfaces(all)
        const en: Record<string, boolean> = {}
        const w: Record<string, string> = {}
        for (const nic of all) {
          en[nic.name] = nic.is_default || selected[nic.name] != null
          w[nic.name] = String(selected[nic.name] ?? 1)
        }
        setEnabled(en)
        setWeights(w)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const enabledCount = useMemo(
    () => ifaces.filter((i) => !i.is_default && enabled[i.name]).length,
    [ifaces, enabled],
  )

  if (!open) return null

  const toggle = (name: string, isDefault: boolean) => {
    if (isDefault) return
    setEnabled((e) => ({ ...e, [name]: !e[name] }))
  }

  const handleConfirm = () => {
    const result: Record<string, number> = {}
    for (const nic of ifaces) {
      if (nic.is_default) continue
      if (nic.connected && !nic.is_virtual && enabled[nic.name]) {
        result[nic.name] = Math.max(1, Number(weights[nic.name]) || 1)
      }
    }
    onConfirm(result)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-spring rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">多网卡分流</h2>
          <Badge variant="secondary">{enabledCount} 个附加网卡已启用</Badge>
        </div>

        <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {ifaces.length === 0 && (
            <p className="text-xs text-muted">daemon 未连接，无法枚举网卡</p>
          )}
          {ifaces.map((nic) => {
            const usable = nic.connected && !nic.is_virtual
            const isOn = enabled[nic.name] ?? nic.is_default
            return (
              <div
                key={nic.name}
                className={`flex items-center justify-between gap-2 rounded-md bg-surface-2/60 px-3 py-2 text-xs ${
                  usable ? '' : 'opacity-50'
                }`}
              >
                <label
                  className={`flex flex-1 items-center gap-2 ${
                    usable && !nic.is_default ? 'cursor-pointer' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={nic.is_default || !usable}
                    onChange={() => toggle(nic.name, nic.is_default)}
                    className="accent-accent"
                  />
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      nic.connected ? 'bg-success' : 'bg-muted'
                    }`}
                  />
                  <span className="font-medium text-zinc-200">{nic.name}</span>
                  {nic.is_default && (
                    <Badge variant="default" className="text-[9px]">主</Badge>
                  )}
                  {nic.is_virtual && (
                    <Badge variant="outline" className="text-[9px]">虚拟</Badge>
                  )}
                  {!nic.connected && (
                    <Badge variant="outline" className="text-[9px] text-danger">未连接</Badge>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  <span className="hidden font-mono text-muted md:inline">
                    {nic.ip ?? '—'}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted">权重</span>
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={weights[nic.name] ?? '1'}
                      onChange={(e) =>
                        setWeights((w) => ({ ...w, [nic.name]: e.target.value }))
                      }
                      disabled={!usable || !isOn}
                      className="h-6 w-14 px-1.5 text-xs"
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          主网卡固定参与；已连接的非虚拟网卡可勾选并按权重分配并发（默认 1:1）。
          未连接（无 IP）或虚拟网卡不可用。
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={handleConfirm}>确定</Button>
        </div>
      </div>
    </div>
  )
}
