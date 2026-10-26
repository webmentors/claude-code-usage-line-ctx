import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const at = (ms: number) => new Date(NOW + ms).toISOString()

const CONTEXT = { window: 200_000 }
const STARTED = NOW - HOUR

// What Claude Code passes to a ui.render hook for the band, apart from the app.
const BAND = {
  plugin: 'usage-line-ctx',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// What the engine (or a mod after this one) would draw in the band.
const engineBand = () => ({ type: 'Text' as const, props: {}, children: ['drawn by Claude Code'] })

type Limits = { kind: string; percentUsed: number; resetsAt?: string }[]

// Stubs every engine answer the mod needs; `usage` is what $.session.usage() returns.
function engine(on: any, usage: { rateLimits: Limits; cost?: { usd: number }; context?: { window: number; tokens?: number; percent?: number } }) {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: { startedAt: STARTED, context: CONTEXT, ...usage } }))
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', engineBand)
  return clock
}

// The innermost Text whose whole text is `text`: the styled run, not the line around it.
function runOf(node: any, text: string): any {
  if (node == null || typeof node === 'string') return undefined
  for (const child of node.children ?? []) {
    const found = runOf(child, text)
    if (found) return found
  }
  return node.type === 'Text' && textOf(node) === text ? node : undefined
}

// The plain text of every Text in a drawn tree, joined.
function textOf(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  return (node.children ?? []).map(textOf).join('')
}

// The text of the line this mod drew, without what the engine drew beside it.
async function lineOf(ui: { find: (q: { type: 'Box' }) => Promise<unknown> }): Promise<string> {
  return textOf(await ui.find({ type: 'Box' })).replace('drawn by Claude Code', '')
}

describe('the band', () => {
  test('both windows draw one line, after what other mods draw', async ($, on) => {
    engine(on, {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: at(3 * 24 * HOUR) },
      ],
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const engineLine = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
      expect(engineLine).toBeDefined()
      const root = await ui.find({ type: 'Box' })
      expect(textOf(root)).toBe('drawn by Claude CodeSes ▰▱▱▱▱ 23% · rst 2h14m     Wk ▰▰▰▱▱▱▱ 41%')
      await ui.unmount()
    }
  })

  test('first paint before any reading draws nothing of its own', async ($, on) => {
    engine(on, { rateLimits: [], cost: { usd: 0 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  })

  test('no rate limits after a reply falls back to the session cost', async ($, on) => {
    engine(on, { rateLimits: [], cost: { usd: 0.12 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' })
    expect(await lineOf(ui)).toBe('Ses cost $0.12')
  })

  test('a reopened session with an old cost shows nothing until a reply finishes', async ($, on) => {
    engine(on, { rateLimits: [], cost: { usd: 4.2 } })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await lineOf(ui)).toBe('')

    // A subscriber's first reply brings the plan figures: no cost line at all.
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: at(4 * HOUR) }],
      cost: { usd: 4.3 },
      changed: ['rateLimits', 'cost'],
    })
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1000, isAborted: false, reason: 'answer' })
    expect(await lineOf(ui)).toBe('Ses ▰▱▱▱▱  4% · rst 4h00m')
  })

  test('session.measure replaces the figures', async ($, on) => {
    engine(on, { rateLimits: [] })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Box' })).toBeUndefined()

    await $.session.measure({
      context: CONTEXT,
      rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: at(37 * MIN) }],
      cost: { usd: 1 },
      changed: ['rateLimits', 'cost'],
    })
    expect(await lineOf(ui)).toBe('Ses ▰▰▰▰▰ 91% · rst 37m')
    const root = await ui.find({ type: 'Box' })
    expect(runOf(root, '▰▰▰▰▰')?.props).toEqual({ color: 'error' })
    expect(runOf(root, '91%')?.props).toEqual({ color: 'error' })
  })

  test('threshold colors: dim, warning, error', async ($, on) => {
    engine(on, {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 69 },
        { kind: 'seven_day', percentUsed: 70 },
        { kind: 'spend_limit', percentUsed: 90 },
      ],
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const root = await ui.find({ type: 'Box' })
    expect(runOf(root, '69%')).toBeDefined()
    expect(runOf(root, '69%')?.props?.color).toBeUndefined()
    expect(runOf(root, '69%')?.props?.dimColor).toBeUndefined()
    expect(runOf(root, '70%')?.props).toEqual({ color: 'warning' })
    expect(runOf(root, '90%')?.props).toEqual({ color: 'error' })
    expect(runOf(root, 'Ses ')?.props).toEqual({ dimColor: true })
  })

  test('a narrow band gets the shorter layouts', async ($, on) => {
    engine(on, {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: at(3 * 24 * HOUR) },
      ],
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const narrow = (bodyColumns: number) => ({ ...BAND, surface: 'terminal' as const, props: { ...BAND.props, bodyColumns } })
    let ui = await $.ui.mount(narrow(40))
    expect(await lineOf(ui)).toBe('Ses 23% · rst 2h14m  Wk 41%')
    await ui.unmount()
    ui = await $.ui.mount(narrow(30))
    expect(await lineOf(ui)).toBe('5h 23% (2h14m) · 7d 41%')
  })

  test('steps aside while a survey holds the band', async ($, on) => {
    engine(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 23 }] })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await lineOf(ui)).toBe('')
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  })

  test('the countdown moves while idle, and a passed reset drops the stale percent', async ($, on) => {
    const clock = engine(on, {
      rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: at(2 * MIN + 30_000) }],
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Ses ▰▰▰▰▰ 95% · rst 2m')

    await clock.advance(MIN)
    expect(await lineOf(ui)).toBe('Ses ▰▰▰▰▰ 95% · rst 1m')

    await clock.advance(2 * MIN)
    expect(await lineOf(ui)).toBe('Ses reset')
  })

  test('once drawn, the minute timer asks for one redraw a minute', async ($, on) => {
    const clock = engine(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: at(HOUR) }] })
    let redraws = 0
    on('ui.invalidate', () => {
      redraws += 1
      return { value: undefined }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(5 * MIN)
    expect(redraws).toBe(5)
  })

  test('figures are read again after /clear', async ($, on) => {
    let reads = 0
    mock.clock(on, { now: NOW })
    on('session.usage', () => {
      reads += 1
      return { value: { startedAt: STARTED, context: CONTEXT, rateLimits: [{ kind: 'seven_day', percentUsed: 10 + reads }] } }
    })
    on('classic.SessionStart', () => ({}))
    on('ui.render', engineBand)
    await $.classic.SessionStart({ source: 'clear' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Wk ▰▱▱▱▱▱▱ 11%')
  })
})

describe('where nothing draws', () => {
  test('claude -p: hooks run, nothing throws, the timer asks for no redraw', async ($, on) => {
    const clock = engine(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: at(HOUR) }] })
    let redraws = 0
    on('ui.invalidate', () => {
      redraws += 1
      return { value: undefined }
    })
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [{ kind: 'five_hour', percentUsed: 24, resetsAt: at(HOUR) }],
      changed: ['rateLimits'],
    })
    await clock.advance(10 * MIN)
    expect(redraws).toBe(0)
  })

  test('the VS Code panel and the mobile app: session events only, no errors', async ($, on) => {
    engine(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 50 }] })
    for (const surface of ['vscode', 'mobile'] as const) {
      const out = await $.session.start({ surface, isInteractive: true, cwd: '/work' })
      expect(out).toEqual({ cwd: '/work' })
    }
  })

  test('a failing usage read leaves the band empty, not broken', async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.start', () => ({ cwd: '/work' }))
    on('session.usage', () => ({ deny: 'unavailable' }))
    on('ui.render', engineBand)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  })
})

describe('the context gauge', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }

  test('read from $.session.usage() on start, first on the line', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 84_000, percent: 42 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('session.measure moves it, and past 90% it turns red', async ($, on) => {
    engine(on, { rateLimits: [FIVE] })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Ses ▰▱▱▱▱ 23% · rst 2h14m')

    await $.session.measure({
      context: { window: 200_000, tokens: 184_000, percent: 92 },
      rateLimits: [FIVE],
      changed: ['context'],
    })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▰ 92% · 184k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    expect(runOf(await ui.find({ type: 'Box' }), '92%')?.props).toEqual({ color: 'error' })
  })

  test('after /compact the gauge leaves until the next reading', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 150_000, percent: 75 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toContain('Cxt')
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toBe('Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('API key, before the first reply: context only, no stale cost', async ($, on) => {
    engine(on, { rateLimits: [], cost: { usd: 4.2 }, context: { window: 200_000, tokens: 20_000, percent: 10 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▱▱▱▱ 10% · 20k/200k')
  })
})

describe('readings that leave out the plan windows', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }
  const WEEK = { kind: 'seven_day', percentUsed: 41, resetsAt: at(3 * 24 * HOUR) }

  test('a context-only measurement keeps Ses and Wk on the line', async ($, on) => {
    engine(on, { rateLimits: [FIVE, WEEK], context: { window: 200_000, tokens: 20_000, percent: 10 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.session.measure({ context: { window: 200_000, tokens: 84_000, percent: 42 }, rateLimits: [], changed: ['context'] })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m     Wk ▰▰▰▱▱▱▱ 41%')
  })

  test('windows that really left (changed names rateLimits) do leave', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 20_000, percent: 10 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.session.measure({ context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [], changed: ['rateLimits'] })
    expect(await lineOf(ui)).toBe('Cxt ▰▱▱▱▱ 10% · 20k/200k')
  })
})

describe('the bars hold on as the band narrows', () => {
  test('tighter gaps, then no tokens, then no bars', async ($, on) => {
    engine(on, {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) },
        { kind: 'seven_day', percentUsed: 41, resetsAt: at(3 * 24 * HOUR) },
      ],
      context: { window: 200_000, tokens: 84_000, percent: 42 },
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const band = (bodyColumns: number) => ({ ...BAND, surface: 'terminal' as const, props: { ...BAND.props, bodyColumns } })
    const lineAt = async (cols: number) => {
      const ui = await $.ui.mount(band(cols))
      const line = await lineOf(ui)
      await ui.unmount()
      return line
    }
    // Band widths, cut-off points exact: each layout at its minimum, and one less.
    expect(await lineAt(120)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m     Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(77)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m     Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(76)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(71)).toBe('Cxt ▰▰▱▱▱ 42% · 84k/200k  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(70)).toBe('Cxt ▰▰▱▱▱ 42%  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(60)).toBe('Cxt ▰▰▱▱▱ 42%  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%')
    expect(await lineAt(59)).toBe('Cxt 42%  Ses 23% · rst 2h14m  Wk 41%')
    expect(await lineAt(40)).toBe('Cxt 42%  Ses 23% · rst 2h14m  Wk 41%')
    expect(await lineAt(39)).toBe('cxt 42% · 5h 23% (2h14m) · 7d 41%')
    expect(await lineAt(20)).toBe('cxt 42% · 5h 23% (2h14m) · 7d 41%')
  })
})

describe('pressing Cxt', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }

  test('past 60% the label is a link that runs /compact', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 144_000, percent: 72 } })
    const ran: string[] = []
    on('command.run', ($: unknown, e: { command: string }) => (ran.push(e.command), { text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 72% · 144k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    expect(await ui.find({ type: 'Button' })).toBeDefined()
    await ui.press({ key: 'compact' })
    expect(ran).toEqual(['compact'])
  })

  test('under 60% there is nothing to press', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 84_000, percent: 42 } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('if /compact cannot start, a toast says so and nothing breaks', async ($, on) => {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 190_000, percent: 95 } })
    const toasts: string[] = []
    on('command.run', () => {
      throw new Error('a turn is running')
    })
    on('ui.toast', ($: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'compact' })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(toasts).toEqual(['Could not start /compact now. Try again when the reply finishes.'])
    expect(await lineOf(ui)).toContain('Cxt')
  })
})

describe('after a compaction', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }

  // The conversation as the compaction receives it.
  const BEFORE = {
    trigger: 'manual' as const,
    messages: [
      { role: 'user' as const, text: 'Build the thing.', toolUses: [] },
      { role: 'assistant' as const, text: 'Built it.', toolUses: [] },
    ],
  }

  function compactingEngine(on: any, skip?: string) {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 150_000, percent: 75 } })
    on('session.compact', () =>
      skip ? { skip } : { messages: [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }] },
    )
  }

  test('Cxt reads Compacted… as soon as the compaction finishes', async ($, on) => {
    compactingEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 75% · 150k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')

    await $.session.compact(BEFORE)
    expect(await lineOf(ui)).toBe('Cxt Compacted…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('an empty reading keeps Compacted…; the next real one replaces it', async ($, on) => {
    compactingEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.session.compact(BEFORE)

    await $.session.measure({ context: { window: 200_000 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toContain('Cxt Compacted…')

    await $.session.measure({ context: { window: 200_000, tokens: 30_000, percent: 15 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toBe('Cxt ▰▱▱▱▱ 15% · 30k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('a vetoed compaction leaves the figure as it was', async ($, on) => {
    compactingEngine(on, 'blocked by a PreCompact hook')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.session.compact(BEFORE)
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 75% · 150k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })
})

// What a live session showed: /compact raises no session.compact to plugins,
// only command.run, and $.session.usage() keeps the old figure until the next
// reply. These follow that sequence.
describe('/compact as Claude Code really runs it', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }
  const BEFORE = { window: 200_000, tokens: 150_000, percent: 75 }
  // /compact as the person types it at the prompt.
  const TYPED = { command: 'compact', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

  function liveEngine(on: any) {
    engine(on, { rateLimits: [FIVE], context: BEFORE })
    // The command compacts without raising session.compact to plugins.
    on('command.run', { command: 'compact' }, () => ({ text: 'Compacted.' }))
  }

  test('typed /compact: Compacted… as soon as the command finishes', async ($, on) => {
    liveEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 75% · 150k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')

    await $.command.run(TYPED)
    expect(await lineOf(ui)).toBe('Cxt Compacted…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('pressing the Cxt link: Compacted… once its /compact finishes', async ($, on) => {
    liveEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'compact' })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(await lineOf(ui)).toBe('Cxt Compacted…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('stale and empty readings keep Compacted…; the next reply replaces it', async ($, on) => {
    liveEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.command.run(TYPED)

    // usage() and any measurement still answering the pre-compaction figure
    await $.session.measure({ context: BEFORE, rateLimits: [FIVE], changed: ['cost'] })
    expect(await lineOf(ui)).toContain('Cxt Compacted…')
    // the live window reset, no reply yet
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toContain('Cxt Compacted…')
    // the reply after the compaction
    await $.session.measure({ context: { window: 200_000, tokens: 35_000, percent: 18 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toBe('Cxt ▰▱▱▱▱ 18% · 35k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('/clear afterwards is not a compaction: the gauge just clears', async ($, on) => {
    liveEngine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toBe('Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })
})

describe('Compacting… while the compaction runs', () => {
  const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: at(2 * HOUR + 14 * MIN) }
  const TYPED = { command: 'compact', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
  const tick = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  // A /compact that runs until the test lets it finish (or fail).
  function slowCompact(on: any) {
    engine(on, { rateLimits: [FIVE], context: { window: 200_000, tokens: 150_000, percent: 75 } })
    const gate: { finish: () => void; fail: (err: Error) => void } = { finish: () => {}, fail: () => {} }
    on('command.run', { command: 'compact' }, () =>
      new Promise((resolve, reject) => {
        gate.finish = () => resolve({ text: 'Compacted.' })
        gate.fail = reject
      }),
    )
    return gate
  }

  test('press Cxt: Compacting…, then Compacted…', async ($, on) => {
    const gate = slowCompact(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 75% · 150k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')

    await ui.press({ key: 'compact' })
    await tick()
    expect(await lineOf(ui)).toBe('Cxt Compacting…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()

    gate.finish()
    await tick()
    expect(await lineOf(ui)).toBe('Cxt Compacted…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('typed /compact goes the same way', async ($, on) => {
    const gate = slowCompact(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    const run = $.command.run(TYPED)
    await tick()
    expect(await lineOf(ui)).toBe('Cxt Compacting…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    gate.finish()
    await run
    expect(await lineOf(ui)).toBe('Cxt Compacted…     Ses ▰▱▱▱▱ 23% · rst 2h14m')
  })

  test('a reply finishing mid-compaction does not interrupt Compacting…', async ($, on) => {
    const gate = slowCompact(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'compact' })
    await tick()
    await $.session.measure({ context: { window: 200_000, tokens: 160_000, percent: 80 }, rateLimits: [FIVE], changed: ['context'] })
    expect(await lineOf(ui)).toContain('Cxt Compacting…')
    gate.finish()
    await tick()
    expect(await lineOf(ui)).toContain('Cxt Compacted…')
  })

  test('a failed compaction goes back to the figure, with a toast', async ($, on) => {
    const gate = slowCompact(on)
    const toasts: string[] = []
    on('ui.toast', ($: unknown, e: { text: string }) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'compact' })
    await tick()
    expect(await lineOf(ui)).toContain('Cxt Compacting…')

    gate.fail(new Error('a turn is running'))
    await tick()
    expect(await lineOf(ui)).toBe('Cxt ▰▰▰▰▱ 75% · 150k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m')
    expect(toasts).toEqual(['Could not start /compact now. Try again when the reply finishes.'])
  })
})
