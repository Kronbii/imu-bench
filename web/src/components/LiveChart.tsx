import { useEffect, useRef } from 'react'

import { isLive, onFrame, type Ring } from '../telemetry'

/*
 * A strip chart for one ring buffer: one y-axis, 2px lines in the axis
 * colours, a legend that doubles as the live value table, and a crosshair
 * that reads every series at the hovered (or keyboard-selected) time. The
 * x-axis is seconds before the newest sample of this stream.
 */

export interface Series {
  name: string
  color: string // CSS var name, e.g. --x
  channel: number
}

interface Props {
  fig: string
  title: string
  unit: string
  ring: Ring
  series: Series[]
  windowS: number
  paused: boolean
  /** smallest y span shown, so a still sensor doesn't magnify noise into a wall */
  minSpan: number
  digits: number
  csvName: string
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function niceStep(span: number, target = 4) {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * mag
}

/** First index (in ring order) whose time is >= t. */
function lowerBound(ring: Ring, t: number) {
  let lo = 0
  let hi = ring.size
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ring.t[ring.at(mid)] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

const fmt = (v: number, d: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d)

export function LiveChart(p: Props) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const tipTime = useRef<HTMLElement>(null)
  const tipVals = useRef<(HTMLElement | null)[]>([])
  const legendVals = useRef<(HTMLElement | null)[]>([])
  const props = useRef(p)
  props.current = p

  useEffect(() => {
    const cv = canvas.current!
    const host = box.current!
    const g = cv.getContext('2d')!
    const colors = () => props.current.series.map((s) => css(s.color))
    let col = colors()
    const surface = css('--surface')
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

    // hover / keyboard cursor, as seconds before the window's end (null = off)
    let cursor: number | null = null
    let frozenEnd = 0
    let lo = -1
    let hi = 1
    let frame = 0
    let lastLegend = 0
    let lastDraw = performance.now()
    const pad = { l: 46, r: 14, t: 10, b: 24 }

    const xOf = (dt: number, win: number) => pad.l + (1 - dt / win) * (W - pad.l - pad.r)

    const draw = (now: number) => {
      const { ring, windowS: win, series, paused, minSpan, digits } = props.current
      if (!paused) frozenEnd = ring.lastT
      const end = frozenEnd
      const start = end - win
      const i0 = Math.max(0, lowerBound(ring, start) - 1)
      const i1 = lowerBound(ring, end + 1e-9)

      // legend values, ~8 Hz
      if (now - lastLegend > 120 && ring.size) {
        lastLegend = now
        const dim = !isLive()
        if (dim !== 'dim' in host.dataset) {
          if (dim) host.dataset.dim = ''
          else delete host.dataset.dim
        }
        const last = ring.at(Math.max(0, i1 - 1))
        series.forEach((s, k) => {
          const el = legendVals.current[k]
          if (el) el.textContent = fmt(ring.ch[s.channel][last], digits)
        })
      }
      if (!visible || !W) return

      // y range: data extent, padded, never narrower than minSpan, eased
      let mn = Infinity
      let mx = -Infinity
      for (let i = i0; i < i1; i++) {
        const j = ring.at(i)
        for (const s of series) {
          const v = ring.ch[s.channel][j]
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
      if (!isFinite(mn)) {
        mn = -minSpan / 2
        mx = minSpan / 2
      }
      const mid = (mn + mx) / 2
      const span = Math.max(minSpan, (mx - mn) * 1.18)
      // grow at once so no sample is ever clipped; shrink over ~250 ms, whatever the frame rate
      const k = paused ? 1 : 1 - Math.exp(-(now - lastDraw) / 250)
      lastDraw = now
      const tLo = mid - span / 2
      const tHi = mid + span / 2
      lo = tLo < lo ? tLo : lo + (tLo - lo) * k
      hi = tHi > hi ? tHi : hi + (tHi - hi) * k
      const yOf = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)

      // grid + y ticks
      const step = niceStep(hi - lo)
      g.font = '10px "Spline Sans Mono Variable", ui-monospace, monospace'
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const y = Math.round(yOf(v)) + 0.5
        const zero = Math.abs(v) < step * 1e-6
        g.strokeStyle = zero ? 'rgba(238, 241, 236, 0.22)' : 'rgba(238, 241, 236, 0.07)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(pad.l, y)
        g.lineTo(W - pad.r, y)
        g.stroke()
        g.fillStyle = 'rgba(238, 241, 236, 0.5)'
        const label = Math.abs(v) < step * 1e-6 ? '0' : +v.toFixed(6) + ''
        g.fillText(label, pad.l - 8, y)
      }
      // x ticks
      g.textAlign = 'center'
      g.textBaseline = 'alphabetic'
      const xs = win <= 10 ? 2 : win <= 30 ? 5 : 10
      for (let s = 0; s <= win; s += xs) {
        const x = xOf(s, win)
        g.fillStyle = 'rgba(238, 241, 236, 0.5)'
        g.fillText(s === 0 ? 'now' : `−${s}s`, Math.min(W - pad.r - 12, x), H - 6)
      }

      // series: per-pixel min/max when there are more samples than pixels
      const plotW = W - pad.l - pad.r
      const n = i1 - i0
      g.save()
      g.beginPath()
      g.rect(pad.l, 0, plotW, H - pad.b + 2)
      g.clip()
      g.lineWidth = 2
      g.lineJoin = 'round'
      g.lineCap = 'round'
      series.forEach((s, k2) => {
        const ch = ring.ch[s.channel]
        g.strokeStyle = col[k2]
        g.beginPath()
        if (n > plotW * 2) {
          let px = -1
          let bmin = 0
          let bmax = 0
          let first = true
          for (let i = i0; i < i1; i++) {
            const j = ring.at(i)
            const x = Math.round(xOf(end - ring.t[j], win))
            const v = ch[j]
            if (x !== px) {
              if (px >= 0) {
                if (first) g.moveTo(px, yOf(bmin))
                else g.lineTo(px, yOf(bmin))
                g.lineTo(px, yOf(bmax))
                first = false
              }
              px = x
              bmin = bmax = v
            } else {
              if (v < bmin) bmin = v
              if (v > bmax) bmax = v
            }
          }
          if (px >= 0) {
            g.lineTo(px, yOf(bmin))
            g.lineTo(px, yOf(bmax))
          }
        } else {
          for (let i = i0; i < i1; i++) {
            const j = ring.at(i)
            const x = xOf(end - ring.t[j], win)
            if (i === i0) g.moveTo(x, yOf(ch[j]))
            else g.lineTo(x, yOf(ch[j]))
          }
        }
        g.stroke()
      })
      g.restore()

      const dotAt = (x: number, y: number, c: string) => {
        g.beginPath()
        g.arc(x, y, 4, 0, Math.PI * 2)
        g.fillStyle = c
        g.fill()
        g.lineWidth = 2
        g.strokeStyle = surface
        g.stroke()
      }

      // end dots
      if (n > 0 && cursor === null) {
        const j = ring.at(i1 - 1)
        const x = xOf(end - ring.t[j], win)
        series.forEach((s, k2) => dotAt(x, yOf(ring.ch[s.channel][j]), col[k2]))
      }

      // crosshair
      const t = tip.current
      if (cursor !== null && n > 0) {
        const target = end - cursor
        let i = lowerBound(ring, target)
        if (i >= i1) i = i1 - 1
        if (i > i0 && Math.abs(ring.t[ring.at(i - 1)] - target) < Math.abs(ring.t[ring.at(i)] - target)) i--
        const j = ring.at(i)
        const x = xOf(end - ring.t[j], win)
        g.strokeStyle = 'rgba(238, 241, 236, 0.35)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(Math.round(x) + 0.5, pad.t)
        g.lineTo(Math.round(x) + 0.5, H - pad.b)
        g.stroke()
        series.forEach((s, k2) => dotAt(x, yOf(ring.ch[s.channel][j]), col[k2]))
        if (t) {
          if (tipTime.current) tipTime.current.textContent = `t − ${(end - ring.t[j]).toFixed(2)} s`
          series.forEach((s, k2) => {
            const el = tipVals.current[k2]
            if (el) el.textContent = fmt(ring.ch[s.channel][j], digits)
          })
          const tw = t.offsetWidth
          t.style.left = `${x + 14 + tw > W ? x - 14 - tw : x + 14}px`
          t.dataset.on = ''
        }
      } else if (t && 'on' in t.dataset) {
        delete t.dataset.on
      }
    }

    const stop = onFrame((now) => {
      // 30 fps is plenty for a strip chart and halves the cost on a Jetson
      if (++frame % 2 === 0) draw(now)
    })

    const setFromX = (clientX: number) => {
      const r = host.getBoundingClientRect()
      const x = clientX - r.left
      if (x < pad.l || x > W - pad.r) cursor = null
      else cursor = (1 - (x - pad.l) / (W - pad.l - pad.r)) * props.current.windowS
    }
    const onMove = (e: PointerEvent) => setFromX(e.clientX)
    const onLeave = () => (cursor = null)
    const onKey = (e: KeyboardEvent) => {
      const win = props.current.windowS
      if (e.key === 'ArrowLeft') cursor = Math.min(win, (cursor ?? 0) + win / 100)
      else if (e.key === 'ArrowRight') cursor = Math.max(0, (cursor ?? 0) - win / 100)
      else if (e.key === 'Escape') cursor = null
      else return
      e.preventDefault()
    }
    const onFocus = () => (cursor = cursor ?? 0)
    const onBlur = () => (cursor = null)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('keydown', onKey)
    host.addEventListener('focus', onFocus)
    host.addEventListener('blur', onBlur)
    const fontsReady = document.fonts?.ready.then(() => (col = colors()))
    void fontsReady

    return () => {
      stop()
      ro.disconnect()
      io.disconnect()
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('keydown', onKey)
      host.removeEventListener('focus', onFocus)
      host.removeEventListener('blur', onBlur)
    }
  }, [])

  const exportCsv = () => {
    const { ring, series, windowS, csvName } = props.current
    const end = ring.lastT
    const rows = ['t_s,' + series.map((s) => s.name.toLowerCase()).join(',')]
    for (let i = lowerBound(ring, end - windowS); i < ring.size; i++) {
      const j = ring.at(i)
      rows.push(ring.t[j].toFixed(4) + ',' + series.map((s) => ring.ch[s.channel][j].toPrecision(7)).join(','))
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }))
    a.download = `${csvName}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <article className="card">
      <span className="tick" />
      <div className="card-head">
        <span className="label">{p.fig}</span>
        <button className="pill" data-variant="quiet" data-size="s" onClick={exportCsv}>
          CSV
        </button>
      </div>
      <h3 className="card-title">
        {p.title}
        <small>{p.unit}</small>
      </h3>
      <div className="legend">
        {p.series.map((s, i) => (
          <span key={s.name} style={{ '--k': `var(${s.color})` } as React.CSSProperties}>
            <i />
            {s.name}
            <b ref={(el) => void (legendVals.current[i] = el)}>—</b>
          </span>
        ))}
      </div>
      <div
        ref={box}
        className="chart"
        tabIndex={0}
        role="img"
        aria-label={`${p.title} in ${p.unit}, last ${p.windowS} seconds. Focus and use the arrow keys to read values.`}
      >
        <canvas ref={canvas} />
        <div ref={tip} className="tooltip" aria-hidden="true">
          <header ref={tipTime} />
          {p.series.map((s, i) => (
            <div key={s.name} style={{ '--k': `var(${s.color})` } as React.CSSProperties}>
              <i />
              <b ref={(el) => void (tipVals.current[i] = el)} />
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      </div>
    </article>
  )
}
