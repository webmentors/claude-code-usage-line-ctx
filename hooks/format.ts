// Pure formatting for the usage line: no mods API, no clock, no I/O.
// register.ts feeds it the figures from session.measure / $.session.usage()
// and draws the runs it returns.

export type Level = 'normal' | 'warn' | 'crit'

// How a run of text is drawn: dim, the plain foreground, or a threshold color.
export type Tone = 'dim' | 'plain' | 'warn' | 'crit'

// `action` marks a run drawn as a pressable link: `compact` runs /compact.
export type Action = 'compact'

// Runs that share an action are drawn as one pressable link; `underline`
// marks the part drawn underlined (the label), so it reads as a link.
export type Run = { text: string; tone: Tone; action?: Action; underline?: boolean }

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

// The live context window: input tokens of the last response against the
// model's window. `tokens`/`percent` are absent until the first response of
// the live window (a fresh session, or just after /compact).
// `compacted` marks the window right after a compaction, before the next
// reply brings its new figure: drawn as "Cxt Compacted…".
// `staleTokens` is the count from before the compaction: a reading that still
// carries it is the old figure, not the new window's.
// `compacting` marks a compaction still running: drawn as "Cxt Compacting…".
export type ContextFill = {
  tokens?: number
  window: number
  percent?: number
  compacting?: boolean
  compacted?: boolean
  staleTokens?: number
}

export type Usage = {
  rateLimits: readonly RateLimit[]
  cost?: { usd: number }
  context?: ContextFill
}

export type Options = {
  showContext: boolean
  showCountdown: boolean
  showCost: boolean
  warnAt: number
  critAt: number
  // The context fill, in percent, from which the Cxt label links to /compact.
  compactAt: number
}

export const DEFAULTS: Options = { showContext: true, showCountdown: true, showCost: true, warnAt: 70, critAt: 90, compactAt: 60 }

// Cells in each mini bar.
export const BAR_CELLS = 5
// The weekly window gets a cell per day.
export const WEEK_CELLS = 7

// Cells in a window's bar.
export function cellsOf(kind: string): number {
  return kind === 'seven_day' ? WEEK_CELLS : BAR_CELLS
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Folds a new reading into the last one. A reading that carries no rate-limit
// windows does not wipe ones already shown unless it says they changed (a
// context-only measurement, or a usage read before the first response), and
// a missing context or cost keeps the last one.
export function mergeUsage(prev: Usage | undefined, next: Partial<Usage> | undefined, changed?: readonly string[]): Usage | undefined {
  if (!next) return prev
  const nextLimits = Array.isArray(next.rateLimits) ? next.rateLimits : []
  const limitsMoved = Array.isArray(changed) && changed.includes('rateLimits')
  const rateLimits = nextLimits.length > 0 || limitsMoved || !prev ? nextLimits : prev.rateLimits
  return {
    rateLimits,
    cost: next.cost ?? prev?.cost,
    context: contextAfter(prev?.context, next.context),
  }
}

// The figures as drawn while a compaction runs: the context reads Compacting…
// whatever reading is held, and the plan windows stay as they are.
export function withCompacting(usage: Usage | undefined): Usage {
  return { rateLimits: usage?.rateLimits ?? [], cost: usage?.cost, context: { window: usage?.context?.window ?? 0, compacting: true } }
}

const hasFill = (c: ContextFill | undefined) => !!c && (Number.isFinite(c.percent) || Number.isFinite(c.tokens))

// A reading with no fill (the engine has none until the next reply) keeps
// "Compacted…" on the line; a reading with a fill always replaces it.
function contextAfter(prev: ContextFill | undefined, next: ContextFill | undefined): ContextFill | undefined {
  if (!next) return prev
  if (prev?.compacted && !next.compacted) {
    if (!hasFill(next)) return prev
    if (prev.staleTokens !== undefined && next.tokens === prev.staleTokens) return prev
  }
  return next
}

// Reads option values, falling back to the defaults when one is missing or
// out of range (a bad value must never hide the line).
export function optionsOf(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const pct = (v: unknown, d: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 && n <= 1000 ? n : d
  }
  const warnAt = pct(raw?.warnAt, DEFAULTS.warnAt)
  const critAt = pct(raw?.critAt, DEFAULTS.critAt)
  return {
    showContext: bool(raw?.showContext, DEFAULTS.showContext),
    showCountdown: bool(raw?.showCountdown, DEFAULTS.showCountdown),
    showCost: bool(raw?.showCost, DEFAULTS.showCost),
    warnAt: Math.min(warnAt, critAt),
    critAt: Math.max(warnAt, critAt),
    compactAt: Math.min(100, pct(raw?.compactAt, DEFAULTS.compactAt)),
  }
}

// Whole percent as shown; the color is judged on this same number so that
// "70%" is never drawn dim.
export function shownPercent(percentUsed: number): number {
  return Math.max(0, Math.round(percentUsed))
}

export function levelOf(percent: number, opts: Options): Level {
  if (percent >= opts.critAt) return 'crit'
  if (percent >= opts.warnAt) return 'warn'
  return 'normal'
}

// 3d4h, 2h05m, 37m, <1m
export function formatRemaining(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY)
    const h = Math.floor((ms % DAY) / HOUR)
    return `${d}d${h}h`
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return `${h}h${String(m).padStart(2, '0')}m`
  }
  return `${Math.floor(ms / MINUTE)}m`
}

// 840, 84k, 1.2M
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(Math.max(0, Math.round(n)))
}

export function formatCost(usd: number): string {
  return '$' + usd.toFixed(2)
}

// Filled cells for a percent: any use shows at least one, and a full bar
// means the window is full.
export function filledCells(percent: number, cells: number = BAR_CELLS): number {
  if (percent <= 0) return 0
  return Math.min(cells, Math.max(1, Math.round((percent * cells) / 100)))
}

// Milliseconds until `resetsAt`, or undefined when it is absent or unreadable.
export function remainingMs(resetsAt: string | undefined, now: number): number | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  return Number.isFinite(at) ? at - now : undefined
}

// One rate-limit window, read and judged, before it is laid out.
export type WindowView = {
  kind: string
  label: string
  short: string
  percent: number
  level: Level
  // Time to the reset, when it is worth showing.
  countdown?: string
  // The reset time has passed: the old percent no longer applies.
  isReset: boolean
  // Extra figure for the full layouts (the context window's tokens).
  detail?: string
  // The label links to an action (the context window past compactAt).
  action?: Action
  // Words in place of the figure (Compacted…).
  status?: string
}

const KINDS: Record<string, { label: string; short: string }> = {
  five_hour: { label: 'Ses', short: '5h' },
  seven_day: { label: 'Wk', short: '7d' },
  spend_limit: { label: 'Spend', short: 'spend' },
  context: { label: 'Cxt', short: 'cxt' },
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

// The context window as a view, when the session has a reading for it.
export function contextOf(usage: Usage | undefined, opts: Options = DEFAULTS): WindowView | undefined {
  const c = usage?.context
  if (!opts.showContext || !c) return undefined
  if (c.compacting) {
    return { kind: 'context', label: 'Cxt', short: 'cxt', percent: 0, level: 'normal', isReset: false, status: 'Compacting…' }
  }
  if (c.compacted && !hasFill(c)) {
    return { kind: 'context', label: 'Cxt', short: 'cxt', percent: 0, level: 'normal', isReset: false, status: 'Compacted…' }
  }
  let raw = c.percent
  if (!Number.isFinite(raw) && Number.isFinite(c.tokens) && Number.isFinite(c.window) && c.window > 0) {
    raw = ((c.tokens as number) / c.window) * 100
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const percent = Math.min(100, shownPercent(raw))
  const hasTokens = typeof c.tokens === 'number' && Number.isFinite(c.tokens) && Number.isFinite(c.window) && c.window > 0
  return {
    kind: 'context',
    label: 'Cxt',
    short: 'cxt',
    percent,
    level: levelOf(percent, opts),
    isReset: false,
    action: percent >= opts.compactAt ? 'compact' : undefined,
    detail: hasTokens ? `${formatTokens(c.tokens as number)}/${formatTokens(c.window)}` : undefined,
  }
}

// Context first (this session's own figure), then the plan windows.
export function windowsOf(usage: Usage | undefined, now: number, opts: Options = DEFAULTS): WindowView[] {
  if (!usage) return []
  const ctx = contextOf(usage, opts)
  return [...(ctx ? [ctx] : []), ...planWindowsOf(usage, now, opts)]
}

export function planWindowsOf(usage: Usage | undefined, now: number, opts: Options = DEFAULTS): WindowView[] {
  if (!usage) return []
  return usage.rateLimits
    .filter((l) => KINDS[l.kind] !== undefined && Number.isFinite(l.percentUsed))
    .slice()
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map((l) => {
      const { label, short } = KINDS[l.kind] ?? { label: l.kind, short: l.kind }
      const left = remainingMs(l.resetsAt, now)
      const isReset = left !== undefined && left <= 0
      const percent = shownPercent(l.percentUsed)
      const level = isReset ? 'normal' : levelOf(percent, opts)
      // The session countdown is always useful; the weekly one only once the
      // week is running hot, to keep the line short.
      const wantsCountdown =
        opts.showCountdown &&
        left !== undefined &&
        !isReset &&
        (l.kind === 'five_hour' || (l.kind === 'seven_day' && level !== 'normal'))
      return {
        kind: l.kind,
        label,
        short,
        percent,
        level,
        countdown: wantsCountdown ? formatRemaining(left) : undefined,
        isReset,
      }
    })
}

const toneOf = (level: Level, otherwise: Tone): Tone =>
  level === 'crit' ? 'crit' : level === 'warn' ? 'warn' : otherwise

const GAP = '     '
// The tighter gap the in-between layouts use before giving up the bars.
const NARROW_GAP = '  '

// Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱  8%
function fullRuns(windows: readonly WindowView[], withBars: boolean, withDetail = withBars, gap = GAP): Run[] {
  return windows.flatMap((w, i) => {
    const gapRuns: Run[] = i === 0 ? [] : [{ text: gap, tone: 'dim' }]
    const runs: Run[] = []
    if (w.action) runs.push({ text: w.label, tone: toneOf(w.level, 'plain'), underline: true }, { text: ' ', tone: 'dim' })
    else runs.push({ text: w.label + ' ', tone: 'dim' })
    if (w.isReset) {
      runs.push({ text: 'reset', tone: 'dim' })
      return [...gapRuns, ...runs]
    }
    if (w.status) {
      runs.push({ text: w.status, tone: 'plain' })
      return [...gapRuns, ...runs]
    }
    if (withBars) {
      const cells = cellsOf(w.kind)
      const filled = filledCells(w.percent, cells)
      if (filled > 0) runs.push({ text: '▰'.repeat(filled), tone: toneOf(w.level, 'plain') })
      if (filled < cells) runs.push({ text: '▱'.repeat(cells - filled), tone: 'dim' })
      runs.push({ text: ' ', tone: 'dim' })
    }
    runs.push({ text: `${w.percent}%`.padStart(withBars ? 3 : 0), tone: toneOf(w.level, 'plain') })
    if (w.detail && withDetail) runs.push({ text: ` · ${w.detail}`, tone: 'dim' })
    if (w.countdown) runs.push({ text: ` · rst ${w.countdown}`, tone: 'dim' })
    return [...gapRuns, ...linked(runs, w.action)]
  })
}

// The whole window (label, bar, percent, tokens) as one link, when it has one.
function linked(runs: Run[], action: Action | undefined): Run[] {
  return action ? runs.map((r) => ({ ...r, action })) : runs
}

// 5h 23% (2h14m) · 7d 41%
function compactRuns(windows: readonly WindowView[]): Run[] {
  return windows.flatMap((w, i) => {
    const runs: Run[] = i === 0 ? [] : [{ text: ' · ', tone: 'dim' }]
    if (w.isReset) {
      runs.push({ text: `${w.short} reset`, tone: 'dim' })
      return runs
    }
    if (w.status) {
      runs.push({ text: `${w.short} ${w.status.toLowerCase()}`, tone: 'dim' })
      return runs
    }
    if (w.action) {
      runs.push(
        ...linked([{ text: w.short, tone: toneOf(w.level, 'plain'), underline: true }, { text: ` ${w.percent}%`, tone: toneOf(w.level, 'dim') }], w.action),
      )
    } else {
      runs.push({ text: `${w.short} ${w.percent}%`, tone: toneOf(w.level, 'dim') })
    }
    if (w.countdown) runs.push({ text: ` (${w.countdown})`, tone: 'dim' })
    return runs
  })
}

export function textOf(runs: readonly Run[]): string {
  return runs.map((r) => r.text).join('')
}

// The layouts from richest to most compact; the first that fits wins.
export function layoutsOf(usage: Usage | undefined, now: number, opts: Options = DEFAULTS): Run[][] {
  const windows = windowsOf(usage, now, opts)
  const hasPlan = planWindowsOf(usage, now, opts).length > 0

  // No plan figures (an API key): the session cost stands in for them.
  const usd = usage?.cost?.usd
  const cost = !hasPlan && opts.showCost && typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? formatCost(usd) : undefined
  const costFull: Run[] = cost ? [{ text: 'Ses cost ', tone: 'dim' }, { text: cost, tone: 'plain' }] : []
  const costShort: Run[] = cost ? [{ text: cost, tone: 'dim' }] : []
  const join = (a: Run[], b: Run[], sep: string): Run[] => (a.length && b.length ? [...a, { text: sep, tone: 'dim' }, ...b] : [...a, ...b])

  if (windows.length > 0) {
    return [
      // Richest first; each step gives up the least before the bars go.
      join(fullRuns(windows, true), costFull, GAP),
      join(fullRuns(windows, true, true, NARROW_GAP), costFull, NARROW_GAP),
      join(fullRuns(windows, true, false, NARROW_GAP), costFull, NARROW_GAP),
      join(fullRuns(windows, false, false, NARROW_GAP), costFull, NARROW_GAP),
      join(compactRuns(windows), costShort, ' · '),
    ]
  }
  if (cost) return [costFull, costShort]
  return []
}

// The runs to draw in `columns` cells (all of the richest layout when the
// width is unknown); the most compact layout when nothing fits, which the
// band then truncates.
// Drops a layout whose text equals the one before it (no tokens to drop, say).
function distinct(layouts: Run[][]): Run[][] {
  return layouts.filter((runs, i) => i === 0 || textOf(runs) !== textOf(layouts[i - 1] ?? []))
}

// The layouts runsFor chooses among, without repeats.
export function ladderOf(usage: Usage | undefined, now: number, opts: Options = DEFAULTS): Run[][] {
  return distinct(layoutsOf(usage, now, opts))
}

export function runsFor(usage: Usage | undefined, now: number, columns: number | undefined, opts: Options = DEFAULTS): Run[] {
  const layouts = ladderOf(usage, now, opts)
  if (layouts.length === 0) return []
  if (columns === undefined) return layouts[0] ?? []
  return layouts.find((runs) => textOf(runs).length <= columns) ?? layouts[layouts.length - 1] ?? []
}

// Whether the drawing changes as time passes (a countdown or a pending reset),
// so the minute timer has something to refresh.
export function isTimeDependent(usage: Usage | undefined): boolean {
  return !!usage?.rateLimits.some((l) => KINDS[l.kind] !== undefined && !!l.resetsAt)
}
