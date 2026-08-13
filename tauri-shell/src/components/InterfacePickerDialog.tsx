import { useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Slider } from './ui/slider'
import { listInterfaces } from '../api/daemon'
import type { NetworkInterface } from '../types'

export interface InterfaceSelection {
  /** 主网卡名（undefined = 自动识别） */
  primary?: string
  /** 主网卡权重（百分比） */
  primaryWeight: number
  /** 启用网卡名 → 权重（百分比，附属网卡） */
  weights: Record<string, number>
}

interface Props {
  open: boolean
  onClose: () => void
  /** 当前已选（含主网卡） */
  selected: InterfaceSelection
  onConfirm: (sel: InterfaceSelection) => void
}


/**
 * 多网卡选择弹窗 v2：
 * - 主网卡可下拉切换（默认自动识别的默认网卡）
 * - 权重 = 滑块 + 百分比（总和 100%，拖拽自动再分配）
 * - 未连接/虚拟网卡禁用；名称单行省略不换行
 */
export function InterfacePickerDialog({ open, onClose, selected, onConfirm }: Props) {
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [primary, setPrimary] = useState<string | undefined>(selected.primary)
  const [primaryWeight, setPrimaryWeight] = useState(selected.primaryWeight)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [weights, setWeights] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!open) return
    listInterfaces()
      .then(({ primary: p, secondaries }) => {
        const all = [p, ...(secondaries ?? [])].filter(Boolean)
        setIfaces(all)
        // 主网卡：沿用上次选择；无则自动识别
        const autoPrimary = p?.name
        const curPrimary = selected.primary && all.some((i) => i.name === selected.primary)
          ? selected.primary
          : autoPrimary
        setPrimary(curPrimary)
        // 启用：默认主网卡开启；其余按 selected
        const en: Record<string, boolean> = {}
        const w: Record<string, number> = {}
        for (const nic of all) {
          en[nic.name] = nic.name === curPrimary || selected.weights[nic.name] != null
          w[nic.name] = selected.weights[nic.name] ?? 0
        }
        setEnabled(en)
        setWeights(w)
        setPrimaryWeight(selected.primaryWeight)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const usable = (nic: NetworkInterface) => nic.connected && !nic.is_virtual

  const connIfaces = useMemo(() => ifaces.filter(usable), [ifaces])
  const enabledNonPrimary = useMemo(
    () => ifaces.filter((i) => usable(i) && enabled[i.name] && i.name !== primary).length,
    [ifaces, enabled, primary],
  )

  // 附属权重合计
  const secondaryTotal = useMemo(
    () => ifaces.reduce((s, i) => s + (enabled[i.name] && i.name !== primary ? weights[i.name] ?? 0 : 0), 0),
    [ifaces, enabled, weights, primary],
  )

  /** 附属网卡权重变化：固定它，主网卡吃剩余 */
  const setSecondaryWeight = (name: string, v: number) => {
    const vv = Math.max(0, Math.min(100, v))
    setWeights((w) => ({ ...w, [name]: vv }))
    setPrimaryWeight(Math.max(0, 100 - (secondaryTotal - (weights[name] ?? 0) + vv)))
  }

  /** 主网卡权重变化：固定它，启用的附属按比例缩放 */
  const setPrimaryWeightFor = (v: number) => {
    const vv = Math.max(0, Math.min(100, v))
    setPrimaryWeight(vv)
    const enabledSec = ifaces.filter((i) => enabled[i.name] && i.name !== primary)
    if (enabledSec.length === 0) return
    const cur = enabledSec.reduce((s, i) => s + (weights[i.name] ?? 0), 0)
    if (cur === 0) return
    const scale = Math.max(0, 100 - vv) / cur
    const next: Record<string, number> = {}
    for (const i of enabledSec) next[i.name] = Math.round((weights[i.name] ?? 0) * scale)
    setWeights((w) => ({ ...w, ...next }))
  }

  const toggle = (name: string) => {
    setEnabled((e) => {
      const next = { ...e, [name]: !e[name] }
      // 重新计算主网卡权重 = 剩余
      const secTotal = ifaces.reduce(
        (s, i) => s + (next[i.name] && i.name !== primary ? weights[i.name] ?? 0 : 0),
        0,
      )
      setPrimaryWeight(Math.max(0, 100 - secTotal))
      return next
    })
  }

  const handleConfirm = () => {
    const result: Record<string, number> = {}
    for (const nic of ifaces) {
      if (nic.name === primary || !usable(nic) || !enabled[nic.name]) continue
      const v = Math.max(1, Math.round(weights[nic.name] ?? 0))
      result[nic.name] = v
    }
    onConfirm({ primary, primaryWeight: Math.max(1, Math.round(primaryWeight)), weights: result })
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
          <h2 className="text-base font-semibold text-zinc-100">多网卡分流</h2>
          <Badge variant="secondary">
            {enabledNonPrimary > 0 ? `${enabledNonPrimary} 个附加网卡` : '仅主网卡'}
          </Badge>
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
                setEnabled((en) => ({ ...en, [name]: true }))
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
            参与分流的「主」网卡；切换后自动识别网卡将作为普通网卡参与。
          </p>
        </div>

        {/* 网卡列表 */}
        <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {ifaces.length === 0 && (
            <p className="text-xs text-muted">daemon 未连接，无法枚举网卡</p>
          )}
          {ifaces.map((nic) => {
            const u = usable(nic)
            const isPrimary = nic.name === primary
            const isOn = enabled[nic.name] ?? isPrimary
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
                {/* 权重滑块（仅启用时显示） */}
                {isOn && u && (
                  <div className="mt-1.5 flex items-center gap-2 pl-6">
                    <Slider
                      value={isPrimary ? primaryWeight : weights[nic.name] ?? 0}
                      min={0}
                      max={100}
                      onChange={(v) =>
                        isPrimary ? setPrimaryWeightFor(v) : setSecondaryWeight(nic.name, v)
                      }
                    />
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] text-zinc-300">
                      {isPrimary ? primaryWeight : weights[nic.name] ?? 0}%
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex items-center justify-between rounded-md bg-surface-2/40 px-3 py-2">
          <span className="text-[11px] text-muted">权重合计（主 + 附加）</span>
          <span
            className={`font-mono text-xs ${
              primaryWeight + secondaryTotal === 100 ? 'text-success' : 'text-warning'
            }`}
          >
            {primaryWeight + secondaryTotal}% / 100%
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          权重为相对比率：60%:40% 表示约 6:4 的并发分配。主网卡始终参与；未连接或虚拟网卡不可选。
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={handleConfirm}>确定</Button>
        </div>
      </div>
    </div>
  )
}
