// usage-line: a one-line view of the context window and the Claude plan's
// usage, drawn in the band above the prompt.
//
// It only reads figures Claude Code already has ($.session.usage() and the
// session.measure event), keeps the latest in a module variable, and draws
// one line. No files, network, processes, environment or store.

import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { isTimeDependent, mergeUsage, optionsOf, runsFor, withCompacting } from './format'
import type { Run, Usage } from './format'

// One redraw a minute keeps the countdown honest while the session is idle.
const TICK_MS = 60_000
// Cells the band keeps for its own collapse mark ([-]) at the end of the row.
const BAND_MARGIN = 4

// The latest figures, from session.measure or $.session.usage().
let latest: Usage | undefined
// Set once the band has been drawn at least once, so the timer never asks for
// redraws in a session where nothing draws (claude -p, the VS Code panel).
let drawn = false
// Set once a reply has finished in this process. Only then does an empty
// rateLimits mean "no plan" (an API key) rather than "no reading yet", as in
// a Desktop session reopened with its old cost: the cost fallback waits for it.
let answered = false

// Seeds the line from the figures Claude Code already holds.
async function refresh($: EngineInterface): Promise<void> {
  try {
    latest = mergeUsage(latest, await $.session.usage())
  } catch {
    // Keep whatever we had; the next session.measure brings fresh figures.
  }
}

// After a compaction the engine has no figure for the new window until the
// next reply: say so ("Cxt Compacted…") instead of the stale pre-compaction
// figure. The next reading with a fill replaces it.
// Set while a compaction runs (from the press or the command's start until it
// resolves or fails): the gauge reads "Cxt Compacting…".
let compacting = false

function markCompacted(): void {
  const before = latest?.context
  const staleTokens = before?.compacted ? before.staleTokens : before?.tokens
  latest = mergeUsage(latest, { rateLimits: [], context: { window: before?.window ?? 0, compacted: true, staleTokens } })
}

export function register(on: On, options: PluginOptions): void {
  const opts = optionsOf(options)

  // Before the first prompt, and again after a reload of this plugin.
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(TICK_MS, () => {
      if (drawn && isTimeDependent(latest)) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // session.start does not fire again after /clear, /resume or /branch.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await refresh($)
    if (drawn) $.ui.invalidate('ui.render')
    return next(e)
  })

  // A compaction finished: no turn follows, so no session.measure either, and
  // $.session.usage() still answers the old figure. Mark the gauge until the
  // next reply brings the new one.
  //
  // /compact typed by the person: Claude Code does not raise session.compact
  // to plugins for it, but the command itself passes through command.run and
  // resolves once the compaction is done.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    compacting = true
    if (drawn) $.ui.invalidate('ui.render')
    try {
      const result = await next(e)
      markCompacted()
      return result
    } finally {
      compacting = false
      if (drawn) $.ui.invalidate('ui.render')
    }
  })

  // Other compactions where the engine does raise the event (auto, a plugin).
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    const wasCompacting = compacting
    compacting = true
    if (drawn) $.ui.invalidate('ui.render')
    try {
      const result = await next(e)
      if (!result.skip) markCompacted()
      return result
    } finally {
      compacting = wasCompacting
      if (drawn) $.ui.invalidate('ui.render')
    }
  })

  // A reply finished: from now on, no rate limits means no plan.
  on('turn.complete', async ($, e, next) => {
    if (!answered) {
      answered = true
      if (drawn) $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // After each turn, and whenever a rate-limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    latest = mergeUsage(latest, { rateLimits: e.rateLimits, cost: e.cost, context: e.context }, e.changed)
    if (drawn) $.ui.invalidate('ui.render')
    return next(e)
  })

  // The band above the prompt: terminal and Desktop only.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey holds the band: step aside.
    if (e.props.hasSurvey) return next(e)
    drawn = true

    const columns = e.props.bodyColumns > BAND_MARGIN ? e.props.bodyColumns - BAND_MARGIN : undefined
    const held = answered || !latest ? latest : { rateLimits: latest.rateLimits, context: latest.context }
    const shown = compacting ? withCompacting(held) : held
    const runs = runsFor(shown, await $.clock.now(), columns, opts)
    if (runs.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const styled = (r: Run) => {
      const tone =
        r.tone === 'crit' ? { color: 'error' as const } : r.tone === 'warn' ? { color: 'warning' as const } : r.tone === 'dim' ? { dimColor: true } : {}
      return Text({ ...tone, ...(r.underline ? { underline: true } : {}), children: [r.text] })
    }

    // /compact, queued by Claude Code until the session is idle, as if typed.
    // A plugin's own $.command.run skips its own command.run hook, so the
    // link marks the gauge itself once the compaction is done.
    const compact = () => {
      if (compacting) return
      compacting = true
      $.ui.invalidate('ui.render')
      void $.command.run({ command: 'compact' }).then(
        () => {
          compacting = false
          markCompacted()
          $.ui.invalidate('ui.render')
        },
        () => {
          compacting = false
          $.ui.invalidate('ui.render')
          $.ui.toast('Could not start /compact now. Try again when the reply finishes.')
        },
      )
    }

    // Plain runs are grouped into Text; the runs of a window with an action
    // (label, bar, percent, tokens) are grouped into one pressable link.
    const parts: ReturnType<typeof Text | typeof Button>[] = []
    let group: Run[] = []
    const flush = (last: boolean) => {
      if (group.length === 0) return
      const children = group.map(styled)
      if (group[0]?.action === 'compact') parts.push(Button({ key: 'compact', plain: true, children, onPress: compact }))
      else parts.push(Text(last ? { wrap: 'truncate-end', children } : { children }))
      group = []
    }
    // The terminal colours what a link holds, so the whole gauge is the link
    // there. Other surfaces draw a Button natively, in one colour, so only
    // the label is the link and the bar, percent and tokens keep their colours.
    const wholeLink = e.surface === 'terminal'
    const shownRuns = wholeLink ? runs : runs.map((r) => (r.action && !r.underline ? { ...r, action: undefined } : r))
    shownRuns.forEach((r) => {
      if (group.length > 0 && group[0]?.action !== r.action) flush(false)
      group.push(r)
    })
    flush(true)

    const line = Box({ flexDirection: 'row', children: parts })

    // Keep what other mods draw in the band, with our line under it.
    const others = await next(e)
    return Box({ flexDirection: 'column', children: [others, line] })
  })
}
