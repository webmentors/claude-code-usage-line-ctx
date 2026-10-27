# usage-line-ctx

Fork of [usage-line 0.3.1](https://github.com/daboy-dev/claude-code-usage-line) by Darío Aboy (MIT) that adds a **context window** gauge.

**Install it once and your Claude plan usage is always on screen in Claude Code. There's no setup command, no `settings.json` edit and no restart script.** It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview): a plugin whose code runs inside Claude Code. It needs **Claude Code v2.1.287 or later**.

It draws one small line just above the prompt:

```text
Cxt ▰▰▱▱▱ 42% · 84k/200k     Ses ▰▱▱▱▱ 23% · rst 2h14m     Wk ▰▰▰▱▱▱▱ 41%
```

* **Cxt (context)**: how full the model's context window is, from the last response's input tokens (the same figure as the status line's `used_percentage`), with tokens used / window size. Yellow at 70%, red at 90%. It hides on a fresh session. While `/compact` runs (typed, or the link below) it reads `Cxt Compacting…`; once it's done, `Cxt Compacted…` until the next reply brings the new figure; Claude Code reports nothing new for the window before then. Auto-compaction is marked the same way where Claude Code raises it to plugins. Compact form: `cxt 42%`.
* **Compact link**: from **60%** context the whole `Cxt` gauge (label, bar, percent and tokens) is pressable, with the label underlined. Clicking it (or focusing the band with ctrl+x tab and pressing Enter) runs `/compact`, exactly as if you typed it, queued until the current reply finishes. The label switches to `Cxt Compacting…` at once, so you can see the press landed.

* **Ses (session)**: how much of your current 5-hour usage window you've used, and the time left until it resets
* **Wk (week)**: your weekly window, with a 7-cell bar (one per day; the others have 5). Its reset countdown appears once it reaches the warning level, as in `Wk ▰▰▰▰▰▱▱ 75% · rst 3d4h`.
* **Spend**: shown too if you use Claude through a gateway that has a spend limit
* **Colors**: a window's bar and percent turn your theme's warning color (yellow) at **70%** and its error color (red) at **90%**. Labels stay dim.
* **Narrow windows**: the line gives up the least it can at each step: first the gaps tighten (`Cxt ▰▰▱▱▱ 42% · 84k/200k  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%`), then the token counts go (`Cxt ▰▰▱▱▱ 42%  Ses ▰▱▱▱▱ 23% · rst 2h14m  Wk ▰▰▰▱▱▱▱ 41%`, about 60 columns), then the bars (`Cxt 42%  Ses 23% · rst 2h14m  Wk 41%`), and last the compact form (`cxt 42% · 5h 23% (2h14m) · 7d 41%`).
* **No plan figures**: before Claude Code has any readings, it shows nothing. If a reply finishes and there are still no plan figures (you sign in with an API key), it shows the session cost instead, such as `Ses cost $0.12`.
* **After a reset**: when a window's reset time has passed, it shows `Ses reset` until fresh figures arrive

The countdown keeps moving while you're idle: the line is refreshed once a minute.

## Install

```bash
claude plugin marketplace add webmentors/claude-code-usage-line-ctx
```

```bash
claude plugin install usage-line-ctx@webmentors
```

If you also have the original `usage-line` installed, remove it first or you'll see two lines: `claude plugin uninstall usage-line@daboy-dev`.

Or in one step on Claude Code 2.1.275 or later:

```bash
/plugin install usage-line-ctx --marketplace webmentors/claude-code-usage-line-ctx
```

That's it. Your next Claude Code session shows the line. If a session is already open, run `/reload-plugins` in it. To check that it loaded, run `/plugin`: the dim line under the tabs reads `1 mod active · usage-line-ctx` (or names it among your other mods).

If your Claude Code is older than v2.1.287, the plugin still installs but does nothing. Update with `claude update`.

### Where it shows

| Where you run Claude Code | Line shown |
| :- | :- |
| `claude` in a terminal, including an editor's terminal | Yes |
| The Desktop app's Code tab | Yes |
| The VS Code extension's chat panel, `claude -p`, cloud sessions | No. Mods draw nothing there, and the mod stays quiet. |

It shares the band above the prompt with other mods, and their content stays. When a survey appears there, the line steps aside. If you have your own `statusLine`, it's unaffected: that draws under the prompt, and this line is above it.

## What it can access

A mod runs with your permissions, so here's exactly what this one does. `claude plugin validate` reads it from the source without running it:

```text
❯ ./register.ts hooks: session.start, classic.SessionStart{source=clear|resume|fork}, command.run{command=compact}, session.compact, turn.complete, session.measure, ui.render{component=AbovePrompt}
❯ ./register.ts calls: $.clock.every, $.clock.now, $.command.run, $.session.usage (via refresh), $.ui.invalidate, $.ui.resolve, $.ui.toast
```

In plain words, it reads the usage figures Claude Code already has (`$.session.usage()` and the `session.measure` event), keeps the latest in memory, and draws one line. It notes when a reply finishes, so it can tell an API-key session from one still waiting for its first reading. A one-minute timer asks for a redraw so the countdown stays current. The one thing it can *do* is run `/compact` (`$.command.run`), and only when you press the `Cxt` link; if that can't start, it shows a toast (`$.ui.toast`).

The one classic hook, `classic.SessionStart`, runs only after `/clear`, `/resume` or `/branch`, because `session.start` doesn't fire again then. It re-reads the usage figures and redraws the line. It changes nothing: the event passes on exactly as it arrived, and the mod adds no context, instructions or settings to the session. The only hook whose result it changes is `ui.render` for the band above the prompt, where it adds its line under whatever is already drawn there.

It does **not** read or write files, make network requests, start processes, read environment variables or settings, submit prompts, run any command other than the `/compact` you press, or touch tool calls. There's also nothing to configure and nothing stored on disk. Check it yourself:

```bash
claude plugin validate ./usage-line-ctx
```

The whole mod is two short files: [`hooks/register.ts`](hooks/register.ts) and [`hooks/format.ts`](hooks/format.ts).

## Privacy

usage-line collects nothing. It has no analytics or telemetry, makes no network requests and stores nothing on disk. The usage figures it shows come from Claude Code itself and stay in memory for the session only.

## Turn it off

* **Remove it**: `claude plugin uninstall usage-line-ctx@webmentors`, or disable it in `/plugin` → **Installed**
* **Collapse the band for now**: ctrl+x ctrl+a
* **Organization policy**: `disableAllHooks`, `allowManagedHooksOnly`, `allowManagedModsOnly`, `--safe-mode` and `--bare` all keep the mod from loading. You just won't see the line.

## Options

There are none, on purpose. Plugin options (`userConfig`) make Claude Code ask you to configure them at install time, even when every option has a default, and that's the extra step this plugin avoids. The thresholds are fixed at 70% and 90%, and the colors follow your theme.

## Develop

```bash
claude --plugin-dir ./usage-line-ctx
```

```bash
claude plugin test ./usage-line-ctx
```

```bash
claude plugin validate ./usage-line-ctx/.claude-plugin/plugin.json --strict
```

Loading the directory once with `--plugin-dir` writes the type declarations for your Claude Code version into `.claude-plugin/types/` (git-ignored). After that, `tsc -p ./usage-line-ctx` type-checks the mod and its tests.

## License

MIT. See [LICENSE](LICENSE). Based on [usage-line](https://github.com/daboy-dev/claude-code-usage-line) © Darío Aboy; context gauge and short labels by Dimitar.
