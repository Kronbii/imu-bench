import { useEffect, useRef } from 'react'

import { displayEuler, onFrame } from '../telemetry'

/*
 * Two classic instruments, drawn in the site's hand: an attitude indicator
 * (horizon, pitch ladder, roll scale) and a heading card. Both are SVG and
 * move by transform every animation frame.
 */

const C = 100
const R = 92
const PX_PER_DEG = 2.1

const polar = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [C + Math.cos(a) * r, C + Math.sin(a) * r] as const
}

export function AttitudeIndicator() {
  const horizon = useRef<SVGGElement>(null)
  const pointer = useRef<SVGGElement>(null)

  useEffect(
    () =>
      onFrame(() => {
        const [roll, pitch] = displayEuler()
        const p = Math.max(-60, Math.min(60, pitch))
        horizon.current?.setAttribute('transform', `rotate(${-roll} ${C} ${C}) translate(0 ${p * PX_PER_DEG})`)
        pointer.current?.setAttribute('transform', `rotate(${-roll} ${C} ${C})`)
      }),
    [],
  )

  const ladder = [-30, -20, -10, 10, 20, 30]
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label="Attitude indicator">
      <defs>
        <clipPath id="adi-clip">
          <circle cx={C} cy={C} r={R - 1} />
        </clipPath>
      </defs>
      <circle cx={C} cy={C} r={R} fill="var(--sunk)" />
      <g clipPath="url(#adi-clip)">
        <g ref={horizon}>
          <rect x={-200} y={C} width={600} height={400} fill="rgba(183, 211, 168, 0.13)" />
          <line x1={-200} x2={400} y1={C} y2={C} stroke="var(--sage)" strokeWidth={1.5} />
          {ladder.map((d) => {
            const y = C - d * PX_PER_DEG
            const half = d % 20 === 0 ? 26 : 16
            return (
              <g key={d}>
                <line x1={C - half} x2={C + half} y1={y} y2={y} stroke="rgba(238, 241, 236, 0.42)" strokeWidth={1} />
                <text
                  x={C + half + 5}
                  y={y + 3}
                  fontFamily="var(--f-mono)"
                  fontSize={8}
                  fill="rgba(238, 241, 236, 0.5)"
                >
                  {Math.abs(d)}
                </text>
              </g>
            )
          })}
        </g>
      </g>
      {/* fixed roll scale */}
      {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((d) => {
        const [x1, y1] = polar(d, R)
        const [x2, y2] = polar(d, R - (d % 30 === 0 ? 10 : 6))
        return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(238, 241, 236, 0.5)" strokeWidth={1.2} />
      })}
      <g ref={pointer}>
        <path d={`M ${C} ${C - R + 12} l -5 9 h 10 z`} fill="var(--sage)" />
      </g>
      {/* the unit, fixed */}
      <path
        d={`M ${C - 40} ${C} h 22 l 8 8 l 10 -8 l 10 8 l 8 -8 h 22`}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={C} cy={C} r={2.4} fill="var(--ink)" />
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--hair2)" />
    </svg>
  )
}

export function HeadingIndicator() {
  const card = useRef<SVGGElement>(null)
  const readout = useRef<SVGTextElement>(null)
  const last = useRef(0)

  useEffect(
    () =>
      onFrame((now) => {
        const [, , yaw] = displayEuler()
        card.current?.setAttribute('transform', `rotate(${-yaw} ${C} ${C})`)
        if (now - last.current > 80 && readout.current) {
          last.current = now
          readout.current.textContent = `${yaw.toFixed(0).padStart(3, '0')}°`
        }
      }),
    [],
  )

  const ticks = []
  for (let d = 0; d < 360; d += 5) {
    const long = d % 30 === 0
    const [x1, y1] = polar(d, R - 2)
    const [x2, y2] = polar(d, R - (long ? 12 : d % 10 === 0 ? 8 : 5))
    ticks.push(
      <line
        key={d}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={d === 0 ? 'var(--sage)' : long ? 'rgba(238, 241, 236, 0.6)' : 'rgba(238, 241, 236, 0.3)'}
        strokeWidth={long ? 1.6 : 1}
      />,
    )
  }
  const labels: [number, string][] = [
    [0, 'N'],
    [30, '3'],
    [60, '6'],
    [90, 'E'],
    [120, '12'],
    [150, '15'],
    [180, 'S'],
    [210, '21'],
    [240, '24'],
    [270, 'W'],
    [300, '30'],
    [330, '33'],
  ]
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label="Heading indicator">
      <circle cx={C} cy={C} r={R} fill="var(--sunk)" />
      <g ref={card}>
        {ticks}
        {labels.map(([d, t]) => {
          const [x, y] = polar(d, R - 24)
          const cardinal = /[NESW]/.test(t)
          return (
            <text
              key={d}
              x={x}
              y={y}
              transform={`rotate(${d} ${x} ${y})`}
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="var(--f-mono)"
              fontSize={cardinal ? 13 : 9}
              fontWeight={cardinal ? 600 : 400}
              fill={t === 'N' ? 'var(--sage)' : cardinal ? 'var(--ink)' : 'rgba(238, 241, 236, 0.55)'}
            >
              {t}
            </text>
          )
        })}
      </g>
      {/* lubber line */}
      <path d={`M ${C} ${C - R - 1} l -6 -0 l 6 13 l 6 -13 z`} fill="var(--sage)" />
      <text
        ref={readout}
        x={C}
        y={C + 4}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="var(--f-mono)"
        fontSize={20}
        fontWeight={500}
        fill="var(--ink)"
      >
        000°
      </text>
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--hair2)" />
    </svg>
  )
}
