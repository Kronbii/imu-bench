import { useEffect, useRef } from 'react'

import { onFrame } from '../telemetry'

/*
 * Shared plumbing for the analysis charts (spectrum, spectrogram, Allan
 * deviation): a canvas sized to its box at the device pixel ratio, redrawn
 * from the frame loop only while it is on screen, and the axis helpers the
 * strip charts use, extended to log scales.
 */

export const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export const INK = (a: number) => `rgba(238, 241, 236, ${a})`
export const MONO = '10px "Spline Sans Mono Variable", ui-monospace, monospace'

export function niceStep(span: number, target = 4) {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * mag
}

/** 1e-4 → "10⁻⁴": decade labels for log axes. */
export function pow10(e: number) {
  const sup: Record<string, string> = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
  if (e === 0) return '1'
  if (e === 1) return '10'
  return '10' + String(e).replace(/./g, (c) => sup[c] ?? c)
}

/** A number for a tooltip: 3 significant digits, exponent when it is very small or large. */
export const sig = (v: number, d = 3) =>
  !isFinite(v) ? '—' : v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(d - 1).replace('e', '×10^') : v.toPrecision(d)

export interface Frame {
  g: CanvasRenderingContext2D
  W: number
  H: number
  now: number
}

/**
 * Draw into a canvas every `every`-th animation frame while it is visible.
 * Returns the ref for the box the canvas fills (the canvas is its first child).
 */
export function useCanvas<T extends HTMLElement>(draw: (f: Frame) => void, every = 2) {
  const box = useRef<T>(null)
  const fn = useRef(draw)
  fn.current = draw
  useEffect(() => {
    const host = box.current!
    const cv = host.querySelector('canvas')!
    const g = cv.getContext('2d')!
    let W = 0
    let H = 0
    let dpr = 1
    const ro = new ResizeObserver(() => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = host.clientWidth
      H = host.clientHeight
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    })
    ro.observe(host)
    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(host)
    let frame = 0
    const stop = onFrame((now) => {
      if (++frame % every || !visible || !W) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      fn.current({ g, W, H, now })
    })
    return () => {
      stop()
      ro.disconnect()
      io.disconnect()
    }
  }, [every])
  return box
}

/** Hover / keyboard position over a chart, as a fraction 0..1 across the plot (null = off). */
export function usePointer<T extends HTMLElement>(box: React.RefObject<T | null>, pad: { l: number; r: number }) {
  const at = useRef<null | { x: number; y: number }>(null)
  useEffect(() => {
    const host = box.current
    if (!host) return
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect()
      const x = (e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r)
      at.current = x < 0 || x > 1 ? null : { x, y: (e.clientY - r.top) / r.height }
    }
    const leave = () => (at.current = null)
    const key = (e: KeyboardEvent) => {
      const x = at.current?.x ?? 0.5
      if (e.key === 'ArrowLeft') at.current = { x: Math.max(0, x - 0.01), y: 0.5 }
      else if (e.key === 'ArrowRight') at.current = { x: Math.min(1, x + 0.01), y: 0.5 }
      else if (e.key === 'Escape') at.current = null
      else return
      e.preventDefault()
    }
    const focus = () => (at.current = at.current ?? { x: 0.5, y: 0.5 })
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerleave', leave)
    host.addEventListener('keydown', key)
    host.addEventListener('focus', focus)
    host.addEventListener('blur', leave)
    return () => {
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerleave', leave)
      host.removeEventListener('keydown', key)
      host.removeEventListener('focus', focus)
      host.removeEventListener('blur', leave)
    }
  }, [box, pad.l, pad.r])
  return at
}

export function dot(g: CanvasRenderingContext2D, x: number, y: number, fill: string, ring: string) {
  g.beginPath()
  g.arc(x, y, 4, 0, Math.PI * 2)
  g.fillStyle = fill
  g.fill()
  g.lineWidth = 2
  g.strokeStyle = ring
  g.stroke()
}

/** Save text as a download. */
export function download(name: string, text: string, type = 'text/plain') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
