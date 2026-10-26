import { describe, expect, test } from 'claude-code/testing'

import {
  cellsOf,
  DEFAULTS,
  filledCells,
  formatRemaining,
  isTimeDependent,
  ladderOf,
  mergeUsage,
  withCompacting,
  layoutsOf,
  levelOf,
  optionsOf,
  runsFor,
  textOf,
  windowsOf,
} from '../hooks/format'
import type { Usage } from '../hooks/format'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (ms: number) => new Date(NOW + ms).toISOString()

// The three layouts' plain text: full with bars, full without, compact.
const layouts = (usage: Usage, opts = DEFAULTS) => ladderOf(usage, NOW, opts).map(textOf)

const BOTH: Usage = {
  rateLimits: [
    { kind: 'seven_day', percentUsed: 8.2, resetsAt: at(3 * DAY) },
    { kind: 'five_hour', percentUsed: 3.4, resetsAt: at(4 * HOUR + 20 * MIN) },
  ],
}

describe('reset formatting', () => {
  test('days and hours past a day', async () => {
    expect(formatRemaining(3 * DAY + 4 * HOUR + 59 * MIN)).toBe('3d4h')
  })
  test('hours and minutes past an hour', async () => {
    expect(formatRemaining(2 * HOUR + 14 * MIN + 30_000)).toBe('2h14m')
    expect(formatRemaining(1 * HOUR + 5 * MIN)).toBe('1h05m')
  })
  test('minutes under an hour', async () => {
    expect(formatRemaining(37 * MIN + 59_000)).toBe('37m')
  })
  test('under a minute', async () => {
    expect(formatRemaining(10_000)).toBe('<1m')
  })
})

describe('bars', () => {
  test('any use shows a cell, and the bar never overflows', async () => {
    expect([0, 3, 8, 15, 75, 92, 100, 112].map((p) => filledCells(p))).toEqual([0, 1, 1, 1, 4, 5, 5, 5])
  })
  test('the weekly bar has a cell per day', async () => {
    expect(cellsOf('seven_day')).toBe(7)
    expect(cellsOf('five_hour')).toBe(5)
    expect(cellsOf('context')).toBe(5)
    expect([0, 3, 8, 15, 41, 50, 75, 92, 100, 112].map((p) => filledCells(p, 7))).toEqual([0, 1, 1, 1, 3, 4, 5, 6, 7, 7])
  })
})

describe('layouts', () => {
  test('both windows, richest to most compact', async () => {
    expect(layouts(BOTH)).toEqual([
      'Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%',
      'Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%',
      'Ses 3% · rst 4h20m  Wk 8%',
      '5h 3% (4h20m) · 7d 8%',
    ])
  })

  test('the widest layout that fits is chosen', async () => {
    expect(textOf(runsFor(BOTH, NOW, 120))).toBe('Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%')
    expect(textOf(runsFor(BOTH, NOW, 42))).toBe('Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%')
    expect(textOf(runsFor(BOTH, NOW, 30))).toBe('Ses 3% · rst 4h20m  Wk 8%')
    expect(textOf(runsFor(BOTH, NOW, 24))).toBe('5h 3% (4h20m) · 7d 8%')
    expect(textOf(runsFor(BOTH, NOW, 10))).toBe('5h 3% (4h20m) · 7d 8%')
    expect(textOf(runsFor(BOTH, NOW, undefined))).toContain('Ses ▰')
  })

  test('only the session window', async () => {
    const usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: at(37 * MIN) }] }
    expect(layouts(usage)[0]).toBe('Ses ▰▱▱▱▱  5% · rst 37m')
  })

  test('only the weekly window, with no countdown while it is cool', async () => {
    const usage = { rateLimits: [{ kind: 'seven_day', percentUsed: 12, resetsAt: at(2 * DAY) }] }
    expect(layouts(usage)[0]).toBe('Wk ▰▱▱▱▱▱▱ 12%')
  })

  test('hot windows: colors on bar and percent, weekly countdown appears', async () => {
    const usage = {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 75, resetsAt: at(HOUR + 5 * MIN) },
        { kind: 'seven_day', percentUsed: 92, resetsAt: at(2 * DAY + 3 * HOUR) },
      ],
    }
    const [full] = layoutsOf(usage, NOW)
    expect(textOf(full ?? [])).toBe('Ses ▰▰▰▰▱ 75% · rst 1h05m     Wk ▰▰▰▰▰▰▱ 92% · rst 2d3h')
    const toned = (full ?? []).filter((r) => r.tone === 'warn' || r.tone === 'crit')
    expect(toned).toEqual([
      { text: '▰▰▰▰', tone: 'warn' },
      { text: '75%', tone: 'warn' },
      { text: '▰▰▰▰▰▰', tone: 'crit' },
      { text: '92%', tone: 'crit' },
    ])
  })

  test('a window without resetsAt has no countdown', async () => {
    const usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 50 }] }
    expect(layouts(usage)[2]).toBe('5h 50%')
    expect(isTimeDependent(usage)).toBe(false)
  })

  test('countdown can be turned off', async () => {
    const usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: at(HOUR) }] }
    expect(layouts(usage, optionsOf({ showCountdown: false }))[1]).toBe('Ses 23%')
  })

  test('a reset in the past drops the stale percent', async () => {
    const usage = {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 95, resetsAt: at(-MIN) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: at(DAY) },
      ],
    }
    expect(layouts(usage)).toEqual([
      'Ses reset     Wk ▰▰▰▱▱▱▱ 41%',
      'Ses reset  Wk ▰▰▰▱▱▱▱ 41%',
      'Ses reset  Wk 41%',
      '5h reset · 7d 41%',
    ])
    expect(windowsOf(usage, NOW)[0]?.level).toBe('normal')
  })

  test('spend limit past 100 is shown as is, in red, with a full bar', async () => {
    const usage = { rateLimits: [{ kind: 'spend_limit', percentUsed: 112.5 }] }
    const [full] = layoutsOf(usage, NOW)
    expect(textOf(full ?? [])).toBe('Spend ▰▰▰▰▰ 113%')
    expect(full?.find((r) => r.text === '113%')?.tone).toBe('crit')
  })

  test('all three windows in a fixed order', async () => {
    const usage = {
      rateLimits: [
        { kind: 'spend_limit', percentUsed: 10 },
        { kind: 'seven_day', percentUsed: 41 },
        { kind: 'five_hour', percentUsed: 23 },
      ],
    }
    expect(layouts(usage).at(-1)).toBe('5h 23% · 7d 41% · spend 10%')
  })

  test('unknown window kinds are ignored', async () => {
    const usage = { rateLimits: [{ kind: 'mystery', percentUsed: 99 }], cost: { usd: 0.5 } }
    expect(layouts(usage)).toEqual(['Ses cost $0.50', '$0.50'])
  })
})

describe('fallbacks', () => {
  test('no rate limits: the session cost', async () => {
    expect(layouts({ rateLimits: [], cost: { usd: 0.1234 } })).toEqual(['Ses cost $0.12', '$0.12'])
  })
  test('cost fallback can be turned off', async () => {
    expect(layoutsOf({ rateLimits: [], cost: { usd: 3 } }, NOW, optionsOf({ showCost: false }))).toEqual([])
  })
  test('nothing available: nothing drawn', async () => {
    expect(runsFor({ rateLimits: [] }, NOW, 80)).toEqual([])
    expect(runsFor({ rateLimits: [], cost: { usd: 0 } }, NOW, 80)).toEqual([])
    expect(runsFor(undefined, NOW, 80)).toEqual([])
  })
})

describe('thresholds', () => {
  test('boundaries at 69, 70, 89, 90', async () => {
    expect(levelOf(69, DEFAULTS)).toBe('normal')
    expect(levelOf(70, DEFAULTS)).toBe('warn')
    expect(levelOf(89, DEFAULTS)).toBe('warn')
    expect(levelOf(90, DEFAULTS)).toBe('crit')
  })
  test('the color follows the shown, rounded percent', async () => {
    const levels = [69.4, 69.5, 89.4, 89.5].map(
      (p) => windowsOf({ rateLimits: [{ kind: 'seven_day', percentUsed: p }] }, NOW)[0]?.level,
    )
    expect(levels).toEqual(['normal', 'warn', 'warn', 'crit'])
  })
  test('custom thresholds, and swapped ones are put in order', async () => {
    expect(optionsOf({ warnAt: 50, critAt: 80 })).toMatchObject({ warnAt: 50, critAt: 80 })
    expect(optionsOf({ warnAt: 95, critAt: 60 })).toMatchObject({ warnAt: 60, critAt: 95 })
    expect(optionsOf({ warnAt: 'junk', critAt: -3 })).toMatchObject({ warnAt: 70, critAt: 90 })
  })
})

describe('context window', () => {
  const CTX = { tokens: 84_312, window: 200_000, percent: 42 }

  test('context comes first, with tokens in the richest layout', async () => {
    expect(layouts({ ...BOTH, context: CTX })).toEqual([
      'Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%',
      'Cxt ▰▰▱▱▱ 42% · 84k/200k  Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%',
      'Cxt ▰▰▱▱▱ 42%  Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%',
      'Cxt 42%  Ses 3% · rst 4h20m  Wk 8%',
      'cxt 42% · 5h 3% (4h20m) · 7d 8%',
    ])
  })

  test('narrow terminals fall back to the compact form', async () => {
    expect(textOf(runsFor({ ...BOTH, context: CTX }, NOW, 60))).toBe('Cxt ▰▰▱▱▱ 42%  Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%')
    expect(textOf(runsFor({ ...BOTH, context: CTX }, NOW, 40))).toBe('Cxt 42%  Ses 3% · rst 4h20m  Wk 8%')
    expect(textOf(runsFor({ ...BOTH, context: CTX }, NOW, 33))).toBe('cxt 42% · 5h 3% (4h20m) · 7d 8%')
  })

  test('no reading yet (fresh session or just compacted): context stays out', async () => {
    expect(layouts({ ...BOTH, context: { window: 200_000 } })[0]).toBe(
      'Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%',
    )
  })

  test('percent is derived from tokens when the engine leaves it out', async () => {
    expect(layouts({ rateLimits: [], context: { tokens: 150_000, window: 200_000 } })[0]).toBe(
      'Cxt ▰▰▰▰▱ 75% · 150k/200k',
    )
  })

  test('warning and critical colors follow the same thresholds', async () => {
    const tones = (percent: number) =>
      layoutsOf({ rateLimits: [], context: { tokens: percent * 2000, window: 200_000, percent } }, NOW, DEFAULTS)[0]!
        .filter((r) => r.text.endsWith('%'))
        .map((r) => r.tone)
    expect(tones(50)).toEqual(['plain'])
    expect(tones(72)).toEqual(['warn'])
    expect(tones(95)).toEqual(['crit'])
  })

  test('million-token windows read as 1M', async () => {
    expect(layouts({ rateLimits: [], context: { tokens: 412_000, window: 1_000_000, percent: 41 } })[0]).toBe(
      'Cxt ▰▰▱▱▱ 41% · 412k/1M',
    )
  })

  test('over-full or junk figures never break the line', async () => {
    expect(layouts({ rateLimits: [], context: { tokens: 250_000, window: 200_000, percent: 125 } })[0]).toContain('100%')
    expect(layouts({ rateLimits: [], context: { tokens: NaN, window: 0, percent: NaN } })).toEqual([])
    expect(layouts({ rateLimits: [], context: { tokens: 5000, window: 0 } })).toEqual([])
  })

  test('API-key session: context plus the session cost', async () => {
    expect(layouts({ rateLimits: [], cost: { usd: 0.12 }, context: CTX })).toEqual([
      'Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses cost $0.12',
      'Cxt ▰▰▱▱▱ 42% · 84k/200k  Ses cost $0.12',
      'Cxt ▰▰▱▱▱ 42%  Ses cost $0.12',
      'Cxt 42%  Ses cost $0.12',
      'cxt 42% · $0.12',
    ])
  })

  test('the cost stays out when plan windows are present', async () => {
    expect(layouts({ ...BOTH, cost: { usd: 3 }, context: CTX })[0]).not.toContain('$')
  })

  test('showContext: false hides it', async () => {
    expect(layouts({ ...BOTH, context: CTX }, optionsOf({ showContext: false }))[0]).not.toContain('Cxt')
  })
})

describe('the compact link', () => {
  const ctx = (percent: number) => ({ rateLimits: [], context: { tokens: percent * 2000, window: 200_000, percent } })
  const linked = (usage: Usage, opts = DEFAULTS) => ladderOf(usage, NOW, opts).map((runs) => runs.filter((r) => r.action).map((r) => r.text))

  test('Cxt links to /compact from 60%, in every layout', async () => {
    expect(linked(ctx(59)).flat()).toEqual([])
    expect(linked(ctx(60)).every((l) => l.length === 1)).toBe(true)
    expect(linked(ctx(60)).map((l) => l[0])).toEqual(['Cxt', 'Cxt', 'Cxt', 'cxt'])
  })

  test('the link changes nothing in the text, so widths stay the same', async () => {
    expect(layouts(ctx(65))).toEqual([
      'Cxt ▰▰▰▱▱ 65% · 130k/200k',
      'Cxt ▰▰▰▱▱ 65%',
      'Cxt 65%',
      'cxt 65%',
    ])
  })

  test('the link takes the threshold color', async () => {
    const link = (p: number) => ladderOf(ctx(p), NOW)[0]!.find((r) => r.action)
    expect(link(65)).toEqual({ text: 'Cxt', tone: 'plain', action: 'compact' })
    expect(link(75)?.tone).toBe('warn')
    expect(link(95)?.tone).toBe('crit')
  })

  test('compactAt moves the threshold; bad values fall back to 60', async () => {
    expect(linked(ctx(55), optionsOf({ compactAt: 50 })).flat().length).toBeGreaterThan(0)
    expect(linked(ctx(55), optionsOf({ compactAt: 'x' })).flat()).toEqual([])
    expect(optionsOf({ compactAt: 5000 }).compactAt).toBe(60)
  })

  test('plan windows never link', async () => {
    const usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 99 }], context: { tokens: 20_000, window: 200_000, percent: 10 } }
    expect(linked(usage).flat()).toEqual([])
  })
})

describe('after a compaction', () => {
  const COMPACTED = { rateLimits: [], context: { window: 200_000, compacted: true } }

  test('Compacted… in place of the figure, in every layout', async () => {
    expect(layouts(COMPACTED)).toEqual(['Cxt Compacted…', 'cxt compacted…'])
    expect(layouts({ ...BOTH, context: { window: 200_000, compacted: true } })).toEqual([
      'Cxt Compacted…     Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%',
      'Cxt Compacted…  Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%',
      'Cxt Compacted…  Ses 3% · rst 4h20m  Wk 8%',
      'cxt compacted… · 5h 3% (4h20m) · 7d 8%',
    ])
  })

  test('no link while compacted', async () => {
    expect(ladderOf(COMPACTED, NOW).flat().filter((r) => r.action)).toEqual([])
  })

  test('mergeUsage keeps Compacted… over an empty reading, never over a real one', async () => {
    expect(mergeUsage(COMPACTED, { rateLimits: [], context: { window: 200_000 } })?.context).toEqual({ window: 200_000, compacted: true })
    expect(mergeUsage(COMPACTED, { rateLimits: [], context: { window: 200_000, tokens: 30_000, percent: 15 } })?.context).toEqual({
      window: 200_000,
      tokens: 30_000,
      percent: 15,
    })
    // An empty reading still clears a stale real one (fresh session).
    const real = { rateLimits: [], context: { tokens: 150_000, window: 200_000, percent: 75 } }
    expect(mergeUsage(real, { rateLimits: [], context: { window: 200_000 } })?.context).toEqual({ window: 200_000 })
  })
})

describe('compacting', () => {
  test('Compacting… in every layout, plan windows kept, no link', async () => {
    const usage = withCompacting({ ...BOTH, context: { tokens: 150_000, window: 200_000, percent: 75 } })
    expect(layouts(usage)).toEqual([
      'Cxt Compacting…     Ses ▰▱▱▱▱  3% · rst 4h20m     Wk ▰▱▱▱▱▱▱  8%',
      'Cxt Compacting…  Ses ▰▱▱▱▱  3% · rst 4h20m  Wk ▰▱▱▱▱▱▱  8%',
      'Cxt Compacting…  Ses 3% · rst 4h20m  Wk 8%',
      'cxt compacting… · 5h 3% (4h20m) · 7d 8%',
    ])
    expect(ladderOf(usage, NOW).flat().filter((r) => r.action)).toEqual([])
  })

  test('shown even before any context reading', async () => {
    expect(layouts(withCompacting(undefined))).toEqual(['Cxt Compacting…', 'cxt compacting…'])
  })
})
