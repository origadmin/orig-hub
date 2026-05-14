import { useRef, useEffect, useCallback } from 'react'

interface SpeedGraphProps {
  dataPoints: number[]
  maxPoints?: number
  height?: number
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s'
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${units[i]}`
}

export function SpeedGraph({ dataPoints, maxPoints = 60, height = 120 }: SpeedGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${rect.width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    const w = rect.width
    const h = height
    const padding = { top: 8, right: 8, bottom: 8, left: 8 }
    const chartW = w - padding.left - padding.right
    const chartH = h - padding.top - padding.bottom

    ctx.clearRect(0, 0, w, h)

    const visible = dataPoints.slice(-maxPoints)
    if (visible.length === 0) return

    const maxVal = Math.max(...visible, 1)
    const yScale = chartH / maxVal

    const isDark = document.documentElement.classList.contains('dark')
    const lineColor = isDark ? 'hsl(220, 70%, 50%)' : 'hsl(220, 70%, 45%)'
    const gradientTop = isDark ? 'rgba(59, 130, 246, 0.4)' : 'rgba(59, 130, 246, 0.3)'
    const gradientBottom = isDark ? 'rgba(59, 130, 246, 0.0)' : 'rgba(59, 130, 246, 0.0)'
    const textColor = isDark ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.5)'

    const stepX = visible.length > 1 ? chartW / (visible.length - 1) : chartW

    const getX = (i: number) => padding.left + i * stepX
    const getY = (val: number) => padding.top + chartH - val * yScale

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
    gradient.addColorStop(0, gradientTop)
    gradient.addColorStop(1, gradientBottom)

    ctx.beginPath()
    ctx.moveTo(getX(0), getY(visible[0]))
    for (let i = 1; i < visible.length; i++) {
      const prevX = getX(i - 1)
      const prevY = getY(visible[i - 1])
      const currX = getX(i)
      const currY = getY(visible[i])
      const cpX = (prevX + currX) / 2
      ctx.bezierCurveTo(cpX, prevY, cpX, currY, currX, currY)
    }
    ctx.strokeStyle = lineColor
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.lineTo(getX(visible.length - 1), padding.top + chartH)
    ctx.lineTo(getX(0), padding.top + chartH)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    const currentSpeed = visible[visible.length - 1]
    ctx.fillStyle = textColor
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(formatSpeed(currentSpeed), w - padding.right, padding.top + 12)
  }, [dataPoints, maxPoints, height])

  useEffect(() => {
    draw()
    const observer = new ResizeObserver(draw)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [draw])

  useEffect(() => {
    const observer = new MutationObserver(draw)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [draw])

  return (
    <div ref={containerRef} className="w-full" style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
