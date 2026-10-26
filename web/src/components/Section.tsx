import type { ReactNode } from 'react'

import type { Level } from '../decode'

/** "SC 02  Signals" over a hairline, then the heading and its lede side by side. */
export function SectionHead({ n, label, title, lede }: { n: string; label: string; title: ReactNode; lede?: ReactNode }) {
  return (
    <>
      <p className="slate">
        <b>SC {n}</b>
        {label}
      </p>
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {lede && <p className="section-lede">{lede}</p>}
      </div>
    </>
  )
}

/** Status glyphs: shape carries the level as well as colour. */
export function StatusIcon({ level }: { level: Level }) {
  const c = level === 'neutral' ? 'var(--ink3)' : `var(--${level})`
  switch (level) {
    case 'good':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke={c} strokeWidth="1.5" />
          <path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'warning':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.8l6.6 12H1.4z" fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 6.2v3.6M8 11.7v.1" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    case 'serious':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.2l6.8 6.8L8 14.8 1.2 8z" fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 5v3.8M8 10.9v.1" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    case 'critical':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.1 1.3h5.8l4.1 4.1v5.8l-4.1 4.1H5.1L1 11.2V5.4z" fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3" fill={c} />
        </svg>
      )
  }
}

export function StatusRow({ level, title, detail, value }: { level: Level; title: string; detail?: ReactNode; value?: ReactNode }) {
  return (
    <div className="srow">
      <StatusIcon level={level} />
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {value !== undefined ? <span className="v">{value}</span> : <span />}
    </div>
  )
}
