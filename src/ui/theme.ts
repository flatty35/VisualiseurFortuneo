/** Chart palette — keep in sync with the CSS variables in index.css (ECharts cannot read them). */
export const THEME = {
  ink: '#e6ebf3',
  muted: '#8b98ad',
  accent: '#4f8cff',
  accentRgb: '79, 140, 255',
  lineRgb: '148, 163, 184',
  ok: '#22c38e',
  danger: '#f2555a',
  neutral: '#8b98ad',
  tri: '#a78bfa',
  triRgb: '167, 139, 250',
  pru: '#f0b429',
  tooltipBg: 'rgba(13, 19, 32, 0.97)',
  font: "Inter, 'Segoe UI', system-ui, sans-serif",
} as const

/** Distinct, sober series colors (portfolio first). */
export const SERIES_PALETTE = [
  '#4f8cff',
  '#22c38e',
  '#f0b429',
  '#f2555a',
  '#a78bfa',
  '#2dd4bf',
  '#fb923c',
  '#94a3b8',
]
